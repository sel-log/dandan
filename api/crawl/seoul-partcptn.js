/**
 * 단단 크롤러 — 서울시 씽글벙글 참여프로그램
 * 목록: https://1in.seoul.go.kr/front/partcptn/partcptnListPage.do (SSR, miv_pageNo)
 * 상세: https://1in.seoul.go.kr/front/partcptn/partcptnView.do?partcptn_id=...
 */

import {
  fetchWithRetry, fetchText, upsertPolicies, mapCategory, normalizeDistrict,
  stripHtml, extractMainText, extractDetailFields, textToConditions, mapWithConcurrency,
} from './_shared.js';

const BASE = 'https://1in.seoul.go.kr';
const LIST = `${BASE}/front/partcptn/partcptnListPage.do`;
const MAX_PAGES    = 30;  // 최대 300건 (10개/페이지 × 30)
const DETAIL_LIMIT = 80;  // 상세 본문 크롤링 상한
const DETAIL_CONC  = 6;

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const r = await fetchWithRetry(`${LIST}?miv_pageNo=${page}`);
      const html = await r.text();
      const items = parseSeoulPartcptn(html);
      if (!items.length) break;
      results.push(...items);
      if (items.length < 10) break;  // 마지막 페이지
    } catch (e) {
      console.warn(`서울 참여프로그램 크롤러 오류 [p${page}]:`, e.message);
      break;
    }
  }

  // 중복 id 제거
  const seen = new Set();
  const deduped = results.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  // ── 상세 본문 크롤링 (Task 3) ──
  let detailOk = 0;
  await mapWithConcurrency(deduped.slice(0, DETAIL_LIMIT), DETAIL_CONC, async (p) => {
    const detail = await fetchDetail(p.apply_url);
    if (detail) { enrichWithDetail(p, detail); detailOk++; }
  });

  if (deduped.length) {
    try { await upsertPolicies(deduped); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(200).json({
    success: true,
    portal: '서울시 씽글벙글 참여프로그램',
    count: deduped.length,
    detail_enriched: detailOk,
  });
}

function parseSeoulPartcptn(html) {
  const items = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return items;

  const rows = tbodyMatch[1].match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    try {
      const titleLinkMatch = row.match(/<a[^>]+href="(\/front\/partcptn\/partcptnView\.do[^"]*)"[^>]*>([^<]+)<\/a>/);
      if (!titleLinkMatch) continue;

      const href = titleLinkMatch[1];
      const apply_url = `${BASE}${href.replace(/&amp;/g, '&')}`;
      const idMatch = href.match(/partcptn_id=([^&]+)/);
      const id = `seoul_partcptn_${idMatch?.[1] || Date.now()}`;
      const title = titleLinkMatch[2].trim();
      if (!title) continue;

      const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
        .map(m => m[1].replace(/<[^>]+>/g, '').trim());
      const district = normalizeDistrict('서울', tds[1]);  // 자치구 정규화 (서울시/전체 → null)

      const periodText = tds[3] || '';
      const endMatch = periodText.match(/~\s*(\d{4}-\d{2}-\d{2})/);
      const apply_end = endMatch ? endMatch[1] : null;

      if (apply_end && new Date(apply_end) < new Date()) continue;  // 마감 제외

      items.push({
        id,
        title,
        org: district ? `서울특별시 ${district}` : '서울특별시',
        org_type: 'local_gov',
        source_portal: 'https://1in.seoul.go.kr/front/partcptn/partcptnListPage.do',
        region_city: '서울',
        region_district: district,
        category: mapCategory(title),
        benefit_summary: title,
        benefit_detail: '',
        conditions_plain: [],
        apply_steps: [],
        apply_method: 'both',
        apply_url,
        apply_start: null,
        apply_end,
        is_recurring: !apply_end,
        match_score: calcScore(title),
        target_summary: '1인가구',
        tags: ['1인가구', '서울', ...(district ? [district] : [])],
        updated_at: new Date().toISOString(),
      });
    } catch { /* skip */ }
  }
  return items;
}

/** 상세 페이지 본문 추출 */
async function fetchDetail(applyUrl) {
  try {
    const html = await fetchText(applyUrl, { timeout: 8000 });
    const text = extractMainText(html, [
      /<div[^>]*class="[^"]*(?:view_cont|view_area|prog_view|detail_cont|board_view)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
      /<div[^>]*class="[^"]*(?:cont|content)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
    ]);
    if (!text || text.length < 30) return null;
    return { text, fields: extractDetailFields(text) };
  } catch { return null; }
}

/** 상세 결과를 정책에 병합 */
function enrichWithDetail(p, detail) {
  const { text, fields } = detail;
  if (text) p.benefit_detail = text.slice(0, 1000);
  if (!p.benefit_summary || p.benefit_summary === p.title) {
    p.benefit_summary = text.slice(0, 200);
  }
  const conds = textToConditions(text);
  if (conds.length) p.conditions_plain = conds;
  if (fields.end) p.apply_end = fields.end;
  if (fields.target) p.target_summary = fields.target.slice(0, 80);
  if (fields.method) p.apply_method = fields.method.slice(0, 60);
  if (p.apply_end) p.is_recurring = false;
}

function calcScore(title) {
  let s = 92;  // 1인가구 전용 포털
  if (/소셜다이닝|다이닝/.test(title)) s += 4;
  if (/청년/.test(title)) s += 3;
  if (/무료/.test(title)) s += 2;
  return Math.min(s, 99);
}

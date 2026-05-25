/**
 * 단단 크롤러 — 서울시 씽글벙글 참여프로그램
 * https://1in.seoul.go.kr/front/partcptn/partcptnListPage.do
 * SSR HTML 파싱, miv_pageNo 파라미터로 페이지네이션
 */

import { fetchWithRetry, upsertPolicies, mapCategory, parseDate } from './_shared.js';

const BASE = 'https://1in.seoul.go.kr';
const LIST = `${BASE}/front/partcptn/partcptnListPage.do`;
const MAX_PAGES = 30; // 최대 300건 (10개/페이지 × 30)

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const url = `${LIST}?miv_pageNo=${page}`;
      const r = await fetchWithRetry(url);
      const html = await r.text();

      const items = parseSeoulPartcptn(html);
      if (!items.length) break;
      results.push(...items);

      // 마지막 페이지 확인
      if (items.length < 10) break;
    } catch (e) {
      console.warn(`서울 참여프로그램 크롤러 오류 [p${page}]:`, e.message);
      break;
    }
  }

  if (results.length) {
    try { await upsertPolicies(results); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(200).json({ success: true, portal: '서울시 씽글벙글 참여프로그램', count: results.length });
}

function parseSeoulPartcptn(html) {
  const items = [];

  // tbody > tr 파싱
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return items;

  const rows = tbodyMatch[1].match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    try {
      // 제목: td.al > a 또는 td:nth-child(3) > a
      const titleLinkMatch = row.match(/<a[^>]+href="(\/front\/partcptn\/partcptnView\.do[^"]*)"[^>]*>([^<]+)<\/a>/);
      if (!titleLinkMatch) continue;

      const href = titleLinkMatch[1];
      const apply_url = `${BASE}${href}`;
      const idMatch = href.match(/partcptn_id=([^&]+)/);
      const id = `seoul_partcptn_${idMatch?.[1] || Date.now()}`;
      const title = titleLinkMatch[2].trim();
      if (!title) continue;

      // td 텍스트 추출 (지역, 접수기간)
      const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
        .map(m => m[1].replace(/<[^>]+>/g, '').trim());
      const district = tds[1] || null;

      // 접수기간
      const periodText = tds[3] || '';
      const endMatch = periodText.match(/~\s*(\d{4}-\d{2}-\d{2})/);
      const apply_end = endMatch ? endMatch[1] : null;

      // 마감 항목 제외
      if (apply_end && new Date(apply_end) < new Date()) continue;

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
    } catch (e) { /* skip */ }
  }
  return items;
}

function calcScore(title) {
  let s = 92; // 1인가구 전용 포털, 기본 점수 높게
  if (/소셜다이닝|다이닝/.test(title)) s += 4;
  if (/청년/.test(title)) s += 3;
  if (/무료/.test(title)) s += 2;
  return Math.min(s, 99);
}

/**
 * 단단 크롤러 — 인천 1인가구 포털 (MVP 2)
 * 목록: https://www.incheon.go.kr/1in/OHH020107
 *
 * ⚠️ 라이브 보정 필요 (1회)
 *   incheon.go.kr는 표준 eGovframe 게시판이라 <table><tbody><tr> 구조일 가능성이 높아
 *   범용 테이블 파서로 작성했다. 단, 실제 행/링크 셀렉터·페이지 파라미터는
 *   배포 후 수동 실행으로 확인해 LIST_URL / PARSE 부분만 미세 조정하면 된다.
 *   수동 실행: /api/crawl/incheon?secret=CRON_SECRET → count / 샘플 확인
 *   마스터 크롤러가 죽지 않도록, 파싱 실패 시 count:0으로 정상 종료한다.
 */

import {
  fetchText, upsertPolicies, mapCategory, parseDate,
  stripHtml, extractMainText, extractDetailFields, textToConditions, mapWithConcurrency,
} from './_shared.js';

const ORIGIN   = 'https://www.incheon.go.kr';
const LIST_URL = 'https://www.incheon.go.kr/1in/OHH020107';  // ← 보정 포인트
const MAX_PAGES    = 5;
const DETAIL_LIMIT = 40;
const DETAIL_CONC  = 5;

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      // eGov 게시판 페이지 파라미터(pageIndex)가 다르면 여기만 조정
      const url = page === 1 ? LIST_URL : `${LIST_URL}?pageIndex=${page}`;
      const html = await fetchText(url, { timeout: 9000 });
      const items = parseBoard(html);
      if (!items.length) break;
      results.push(...items);
      if (items.length < 10) break;
    } catch (e) {
      console.warn(`인천 크롤러 오류 [p${page}]:`, e.message);
      break;
    }
  }

  // 중복 제거
  const seen = new Set();
  const deduped = results.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  // 상세 본문 크롤링
  let detailOk = 0;
  await mapWithConcurrency(deduped.slice(0, DETAIL_LIMIT), DETAIL_CONC, async (p) => {
    if (!p.apply_url) return;
    const detail = await fetchDetail(p.apply_url);
    if (detail) { enrichWithDetail(p, detail); detailOk++; }
  });

  if (deduped.length) {
    try { await upsertPolicies(deduped); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(200).json({
    success: true,
    portal: '인천 1인가구 포털',
    count: deduped.length,
    detail_enriched: detailOk,
  });
}

/** 범용 게시판 테이블 파서 — <tbody> 내 각 <tr>에서 제목 링크 + 날짜 추출 */
function parseBoard(html) {
  const items = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return items;

  const rows = tbodyMatch[1].match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    try {
      const linkMatch = row.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;

      const href  = linkMatch[1].replace(/&amp;/g, '&');
      const title = stripHtml(linkMatch[2]);
      if (!title || title.length < 3) continue;

      const apply_url = resolveUrl(href);
      const idKey = (href.match(/(?:nttNo|nttId|bbsNo|idx|seq)=([^&]+)/i) || [])[1]
                    || hashStr(apply_url);
      const id = `incheon_${idKey}`;

      // 행 내 날짜 → 마감일 후보
      const dateMatch = row.match(/\d{4}[.\-]\d{1,2}[.\-]\d{1,2}/);
      const apply_end = dateMatch ? parseDate(dateMatch[0]) : null;

      items.push(basePolicy(id, title, apply_url, apply_end));
    } catch { /* skip */ }
  }
  return items;
}

function basePolicy(id, title, apply_url, apply_end) {
  return {
    id,
    title,
    org: '인천광역시',
    org_type: 'local_gov',
    source_portal: LIST_URL,
    region_city: '인천',
    region_district: null,
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
    tags: ['1인가구', '인천'],
    updated_at: new Date().toISOString(),
  };
}

async function fetchDetail(url) {
  try {
    const html = await fetchText(url, { timeout: 8000 });
    const text = extractMainText(html);
    if (!text || text.length < 30) return null;
    return { text, fields: extractDetailFields(text) };
  } catch { return null; }
}

function enrichWithDetail(p, detail) {
  const { text, fields } = detail;
  if (text) p.benefit_detail = text.slice(0, 1000);
  if (!p.benefit_summary || p.benefit_summary === p.title) p.benefit_summary = text.slice(0, 200);
  const conds = textToConditions(text);
  if (conds.length) p.conditions_plain = conds;
  if (fields.end) { p.apply_end = fields.end; p.is_recurring = false; }
  if (fields.target) p.target_summary = fields.target.slice(0, 80);
  if (fields.method) p.apply_method = fields.method.slice(0, 60);
}

function resolveUrl(href) {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('/')) return ORIGIN + href;
  return `${LIST_URL.replace(/\/[^/]*$/, '')}/${href}`;
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h).toString(36);
}

function calcScore(title) {
  let s = 88;
  if (/소셜다이닝|다이닝|커뮤니티/.test(title)) s += 5;
  if (/청년/.test(title)) s += 4;
  if (/무료/.test(title)) s += 3;
  return Math.min(s, 99);
}

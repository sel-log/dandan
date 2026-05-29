/**
 * 단단 크롤러 — 인천 1인가구 포털 (MVP 2)
 * 목록: https://www.incheon.go.kr/1in/OHH020107  (16건 SSR, JS 페이징)
 *        항목은 href="#"+JS클릭이라, oneHouseHoldId(=A+숫자코드)가 onclick/data 속성에 있음.
 * 상세: https://www.incheon.go.kr/fnct/1in/searchListPopup?oneHouseHoldId={ID}  (팝업)
 *
 * 목록 HTML에서 (oneHouseHoldId, 제목) 쌍을 추출 → 상세 팝업으로 본문/구 보강.
 * 인천 1in 프로그램 다수는 인천광역시 전역(구 null = 공통)이라 그대로 둔다.
 */

import {
  fetchText, upsertPolicies, mapCategory, parseDate,
  stripHtml, extractMainText, extractDetailFields, textToConditions, mapWithConcurrency,
} from './_shared.js';

const ORIGIN = 'https://www.incheon.go.kr';
const LIST_PAGES = [
  'https://www.incheon.go.kr/1in/OHH020107',  // 지원사업 (전체 16건 SSR)
];
const DETAIL_BASE  = `${ORIGIN}/fnct/1in/searchListPopup?oneHouseHoldId=`;
const DETAIL_LIMIT = 50;
const DETAIL_CONC  = 5;

// 인천 군·구 (긴 이름 우선)
const INCHEON_GU = [
  '미추홀구', '부평구', '연수구', '남동구', '계양구', '강화군', '옹진군', '중구', '동구', '서구',
];

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];
  for (const listUrl of LIST_PAGES) {
    try {
      const html = await fetchText(listUrl, { timeout: 9000 });
      results.push(...parseList(html));
    } catch (e) {
      console.warn(`인천 크롤러 오류 [${listUrl}]:`, e.message);
    }
  }

  // 중복 제거
  const seen = new Set();
  const deduped = results.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  // 상세 팝업 크롤링 (본문/신청기간/구 보강)
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
    portal: '인천 1인가구 포털',
    count: deduped.length,
    detail_enriched: detailOk,
  });
}

/** 목록 파싱 — (oneHouseHoldId, 제목) 쌍 추출. ID는 onclick/data 속성(A+숫자코드)에 위치 */
function parseList(html) {
  const items = [];
  const seenId = new Set();
  // ...'A2026...374')"> 또는 ..."A2026...374"> 직후의 요소 텍스트(제목)
  const re = /([A-Z]\d{18,})['")\]][\s\S]*?>([\s\S]*?)<\/(?:a|li|button|span|p|strong|div|dt|td)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const oneId = m[1];
      const title = stripHtml(m[2]).trim();
      if (!title || title.length < 3 || seenId.has(oneId)) continue;
      // 메뉴/네비 텍스트 거르기 (너무 길거나 특수문자 위주)
      if (title.length > 60) continue;
      seenId.add(oneId);

      const gu = extractGu(title);
      items.push(basePolicy(`incheon_${oneId}`, title, `${DETAIL_BASE}${oneId}`, gu));
    } catch { /* skip */ }
  }
  return items;
}

function basePolicy(id, title, apply_url, gu) {
  return {
    id,
    title,
    org: gu ? `인천광역시 ${gu}` : '인천광역시',
    org_type: 'local_gov',
    source_portal: 'https://www.incheon.go.kr/1in/OHH020107',
    region_city: '인천',
    region_district: gu,
    category: mapCategory(title),
    benefit_summary: title,
    benefit_detail: '',
    conditions_plain: [],
    apply_steps: [],
    apply_method: 'both',
    apply_url,
    apply_start: null,
    apply_end: null,
    is_recurring: true,
    match_score: calcScore(title),
    target_summary: '1인가구',
    tags: ['1인가구', '인천', ...(gu ? [gu] : [])],
    updated_at: new Date().toISOString(),
  };
}

function extractGu(text) {
  if (!text) return null;
  for (const g of INCHEON_GU) if (text.includes(g)) return g;
  return null;
}

async function fetchDetail(url) {
  try {
    const html = await fetchText(url, { timeout: 8000 });
    const text = extractMainText(html);
    if (!text || text.length < 20) return null;
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
  // 지원대상/본문 앞부분에서 구 보강 (없으면 인천 공통 유지)
  if (!p.region_district) {
    const gu = extractGu((fields.target || '') + ' ' + text.slice(0, 400));
    if (gu) { p.region_district = gu; p.org = `인천광역시 ${gu}`; if (!p.tags.includes(gu)) p.tags.push(gu); }
  }
}

function calcScore(title) {
  let s = 88;
  if (/소셜다이닝|다이닝|수다살롱|커뮤니티|밥상/.test(title)) s += 5;
  if (/청년/.test(title)) s += 4;
  if (/무료/.test(title)) s += 3;
  return Math.min(s, 99);
}

/**
 * 단단 크롤러 — 인천 1인가구 포털 (MVP 2)
 * 목록: https://www.incheon.go.kr/1in/OHH020108 (분야별 지원사업), OHH020107 (지원사업)
 * 상세: https://www.incheon.go.kr/1in/OHH0201xx/view?oneHouseHoldId={ID}
 *
 * 상세 링크(oneHouseHoldId=)를 기준으로 항목 추출 → 테이블/리스트 구조 무관.
 * 구는 제목/주변 텍스트에서 추출 (인천 10개 군·구).
 * incheon.go.kr는 robots로 외부 점검이 막혀 있어, 배포 후 count로 검증한다.
 */

import {
  fetchText, upsertPolicies, mapCategory, parseDate,
  stripHtml, extractMainText, extractDetailFields, textToConditions, mapWithConcurrency,
} from './_shared.js';

const ORIGIN = 'https://www.incheon.go.kr';
const LIST_PAGES = [
  'https://www.incheon.go.kr/1in/OHH020108',  // 분야별 지원사업
  'https://www.incheon.go.kr/1in/OHH020107',  // 지원사업
];
const MAX_PAGES    = 5;
const DETAIL_LIMIT = 50;
const DETAIL_CONC  = 5;

// 인천 군·구 (긴 이름 우선: 미추홀구 → 부평구 → ... → 중구/동구/서구)
const INCHEON_GU = [
  '미추홀구', '부평구', '연수구', '남동구', '계양구', '강화군', '옹진군', '중구', '동구', '서구',
];

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];
  for (const listUrl of LIST_PAGES) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      try {
        const url = page === 1 ? listUrl : `${listUrl}?curPage=${page}`;
        const html = await fetchText(url, { timeout: 9000 });
        const items = parseList(html);
        if (!items.length) break;
        results.push(...items);
        if (items.length < 8) break;
      } catch (e) {
        console.warn(`인천 크롤러 오류 [${listUrl} p${page}]:`, e.message);
        break;
      }
    }
  }

  // 중복 제거
  const seen = new Set();
  const deduped = results.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  // 상세 본문 크롤링 (구 보강 포함)
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

/** 목록 파싱 — 상세 링크(oneHouseHoldId=) 기준 */
function parseList(html) {
  const items = [];
  const linkRe = /<a[^>]*href="([^"]*oneHouseHoldId=([^"&]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    try {
      const href  = m[1].replace(/&amp;/g, '&');
      const oneId = m[2];
      const title = stripHtml(m[3]);
      if (!title || title.length < 3) continue;

      const after  = stripHtml(html.slice(m.index + m[0].length, m.index + m[0].length + 160));
      // 구는 제목에서만 추출 (목록 윈도우는 옆 항목 구를 잘못 가져올 수 있음).
      // 제목에 없으면 null(인천 공통) → 상세 본문에서 보강.
      const gu = extractGu(title);

      const dates = (after.match(/\d{4}[.\-]\d{1,2}[.\-]\d{1,2}/g) || []);
      const apply_end = dates.length >= 2 ? parseDate(dates[1]) : (dates[0] ? parseDate(dates[0]) : null);

      items.push({
        id: `incheon_${oneId}`,
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
        apply_url: resolveUrl(href),
        apply_start: dates[0] ? parseDate(dates[0]) : null,
        apply_end,
        is_recurring: !apply_end,
        match_score: calcScore(title),
        target_summary: '1인가구',
        tags: ['1인가구', '인천', ...(gu ? [gu] : [])],
        updated_at: new Date().toISOString(),
      });
    } catch { /* skip */ }
  }
  return items;
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
  // 목록에서 구를 못 잡았으면 상세 본문 앞부분에서 보강
  if (!p.region_district) {
    const gu = extractGu(text.slice(0, 600));
    if (gu) { p.region_district = gu; p.org = `인천광역시 ${gu}`; if (!p.tags.includes(gu)) p.tags.push(gu); }
  }
}

function resolveUrl(href) {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('/')) return ORIGIN + href;
  return `${ORIGIN}/1in/${href.replace(/^\/?/, '')}`;
}

function calcScore(title) {
  let s = 88;
  if (/소셜다이닝|다이닝|수다살롱|커뮤니티|밥상/.test(title)) s += 5;
  if (/청년/.test(title)) s += 4;
  if (/무료/.test(title)) s += 3;
  return Math.min(s, 99);
}

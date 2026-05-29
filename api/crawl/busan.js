/**
 * 단단 크롤러 — 부산 1인가구 지원센터 (모여봐요 부산시 1인가구)
 * 목록: http://www.busan1.or.kr/program_01.html?query=list&page=N  (EUC-KR)
 * 상세: http://www.busan1.or.kr/program_01.html?query=view&id={id}&page={page}
 *
 * 사이트가 frameset 구조라 홈(/)이 아니라 program_01.html을 직접 호출해야 목록이 나온다.
 * 구는 센터명에서 추출 (금정구가족센터 → 금정구).
 * EUC-KR은 _shared.fetchText가 자동 디코딩.
 */

import {
  fetchText, upsertPolicies, mapCategory, parseDate,
  stripHtml, extractMainText, extractDetailFields, textToConditions, mapWithConcurrency,
} from './_shared.js';

const ORIGIN = 'http://www.busan1.or.kr';
const LIST   = `${ORIGIN}/program_01.html`;
const MAX_PAGES    = 10;
const DETAIL_LIMIT = 60;
const DETAIL_CONC  = 5;

// 부산 군·구 (긴 이름 우선 매칭: 부산진구가 진구보다 먼저)
const BUSAN_GU = [
  '해운대구','부산진구','영도구','동래구','사하구','금정구','강서구',
  '연제구','수영구','사상구','기장군','중구','서구','동구','남구','북구',
];

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      // 목록은 program_01.html 기본뷰 (query=list 아님). 2페이지부터 ?page=N
      const url = page === 1 ? LIST : `${LIST}?page=${page}`;
      const html = await fetchText(url, { timeout: 9000 });
      const items = parseList(html, page);
      if (!items.length) break;
      results.push(...items);
      if (items.length < 5) break;  // 마지막 페이지
    } catch (e) {
      console.warn(`부산 크롤러 오류 [p${page}]:`, e.message);
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
    const detail = await fetchDetail(p._viewUrl);
    if (detail) { enrichWithDetail(p, detail); detailOk++; }
  });

  const policies = deduped.map(({ _viewUrl, ...rest }) => rest);

  if (policies.length) {
    try { await upsertPolicies(policies); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(200).json({
    success: true,
    portal: '부산 1인가구 지원센터',
    count: policies.length,
    detail_enriched: detailOk,
  });
}

/** 목록 테이블 파싱: 번호 / 센터명 / 프로그램명 / 접수기간 / 진행기간 / 모집인원 / 진행상태 */
function parseList(html, page) {
  const items = [];
  const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const scope = tbody ? tbody[1] : html;
  const rows  = scope.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    try {
      // 상세 id 추출 (href / onclick 양쪽 대응)
      const idMatch = row.match(/(?:query=view[^"']*?id=|[?&]id=|view\(['"]?)(\d+)/i);
      if (!idMatch) continue;
      const id = idMatch[1];

      const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => stripHtml(m[1]));
      if (tds.length < 3) continue;

      const aMatch = row.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
      const center = tds[1] || '';
      const title  = (aMatch ? stripHtml(aMatch[1]) : '') || tds[2] || '';
      if (!title) continue;

      const status = tds[tds.length - 1] || '';
      // 부산은 프로그램이 띄엄띄엄 올라오므로 마감 건도 수집(앱에서 '마감' 표시).

      // 접수기간 = tds[3] (번호0/센터1/제목2/접수기간3/진행기간4/모집5/상태6)
      const dates = (tds[3] || '').match(/\d{4}[.\-]\d{1,2}[.\-]\d{1,2}/g);
      const apply_start = dates && dates[0] ? parseDate(dates[0]) : null;
      const apply_end   = dates && dates.length >= 2 ? parseDate(dates[1]) : (dates && dates[0] ? parseDate(dates[0]) : null);

      const gu = extractGu(center) || extractGu(title);
      const viewUrl = `${LIST}?query=view&id=${id}&page=${page}`;

      items.push({
        id: `busan_${id}`,
        title,
        org: center ? `부산광역시 ${center}` : '부산광역시',
        org_type: 'local_gov',
        source_portal: 'http://www.busan1.or.kr/',
        region_city: '부산',
        region_district: gu,
        category: mapCategory(title),
        benefit_summary: title,
        benefit_detail: '',
        conditions_plain: [],
        apply_steps: [],
        apply_method: 'both',
        apply_url: viewUrl,
        apply_start,
        apply_end,
        is_recurring: false,
        match_score: calcScore(title),
        target_summary: '1인가구',
        tags: ['1인가구', '부산', ...(gu ? [gu] : [])],
        updated_at: new Date().toISOString(),
        _viewUrl: viewUrl,
      });
    } catch { /* skip */ }
  }
  return items;
}

/** 센터명/텍스트에서 부산 군·구 추출 (긴 이름 우선) */
function extractGu(text) {
  if (!text) return null;
  for (const g of BUSAN_GU) if (text.includes(g)) return g;
  return null;
}

async function fetchDetail(url) {
  try {
    const html = await fetchText(url, { timeout: 8000 });  // EUC-KR 자동
    const text = extractMainText(html, [
      /<div[^>]*class="[^"]*(?:program_view|view_cont|detail|cont)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
    ]);
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
  // 상세 본문/주소에 구가 있으면 보강 (목록 센터명에서 못 잡았을 때)
  if (!p.region_district) {
    const gu = extractGu(text);
    if (gu) { p.region_district = gu; if (!p.tags.includes(gu)) p.tags.push(gu); }
  }
}

function calcScore(title) {
  let s = 88;
  if (/소셜다이닝|다이닝|커뮤니티|관계망/.test(title)) s += 5;
  if (/청년/.test(title)) s += 4;
  if (/무료/.test(title)) s += 3;
  return Math.min(s, 99);
}

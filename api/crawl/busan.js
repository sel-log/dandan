/**
 * 단단 크롤러 — 부산 1인가구 지원센터 (MVP 2)
 * 목록: http://www.busan1.or.kr/  (EUC-KR 인코딩 → _shared.fetchText가 자동 디코딩)
 *
 * ⚠️ 라이브 보정 필요 (1회)
 *   busan1.or.kr는 게시판 경로가 공개돼 있지 않아, 홈/목록에서
 *   "프로그램 신청" 게시판 링크를 범용으로 긁도록 작성했다.
 *   실제 목록 경로를 확인하면 BOARD_URLS 배열에 추가하면 된다.
 *   수동 실행: /api/crawl/busan?secret=CRON_SECRET → count 확인
 *   파싱 실패 시 count:0으로 정상 종료 (마스터 크롤러 보호).
 */

import {
  fetchText, upsertPolicies, mapCategory, parseDate,
  stripHtml, extractMainText, extractDetailFields, textToConditions, mapWithConcurrency,
} from './_shared.js';

const ORIGIN = 'http://www.busan1.or.kr';
// 목록 후보 경로 — 라이브 확인 후 정확한 게시판 URL을 맨 앞에 추가
const BOARD_URLS = [
  'http://www.busan1.or.kr/',
];
const DETAIL_LIMIT = 40;
const DETAIL_CONC  = 5;

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];

  for (const boardUrl of BOARD_URLS) {
    try {
      const html = await fetchText(boardUrl, { timeout: 9000 });
      results.push(...parseBoard(html, boardUrl));
    } catch (e) {
      console.warn(`부산 크롤러 오류 [${boardUrl}]:`, e.message);
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
    portal: '부산 1인가구 지원센터',
    count: deduped.length,
    detail_enriched: detailOk,
  });
}

/**
 * 범용 게시판 파서.
 *  1) <tbody><tr> 테이블형이면 행에서 제목 링크 추출
 *  2) 아니면 게시판 view 링크 패턴(bbs/board/view/read + 식별자)을 가진 <a> 수집
 */
function parseBoard(html, baseUrl) {
  const items = [];

  // (1) 테이블형
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (tbodyMatch) {
    const rows = tbodyMatch[1].match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const a = row.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!a) continue;
      const title = stripHtml(a[2]);
      if (!title || title.length < 3) continue;
      const dateMatch = row.match(/\d{4}[.\-]\d{1,2}[.\-]\d{1,2}/);
      items.push(makePolicy(title, resolveUrl(a[1], baseUrl), dateMatch ? parseDate(dateMatch[0]) : null));
    }
    if (items.length) return items;
  }

  // (2) 링크 패턴형
  const anchorRe = /<a[^>]+href="([^"]*(?:bbs|board|view|read|program|notice)[^"]*(?:idx|seq|no|id|wr_id)=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const title = stripHtml(m[2]);
    if (!title || title.length < 4) continue;
    items.push(makePolicy(title, resolveUrl(m[1].replace(/&amp;/g, '&'), baseUrl), null));
  }
  return items;
}

function makePolicy(title, apply_url, apply_end) {
  const idKey = (apply_url.match(/(?:idx|seq|no|id|wr_id)=([^&]+)/i) || [])[1] || hashStr(apply_url);
  return {
    id: `busan_${idKey}`,
    title,
    org: '부산광역시',
    org_type: 'local_gov',
    source_portal: 'http://www.busan1.or.kr/',
    region_city: '부산',
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
    tags: ['1인가구', '부산'],
    updated_at: new Date().toISOString(),
  };
}

async function fetchDetail(url) {
  try {
    const html = await fetchText(url, { timeout: 8000 });  // EUC-KR 자동 처리
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

function resolveUrl(href, baseUrl) {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('/')) return ORIGIN + href;
  return baseUrl.replace(/\/[^/]*$/, '/') + href;
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return Math.abs(h).toString(36);
}

function calcScore(title) {
  let s = 88;
  if (/소셜다이닝|다이닝|커뮤니티|관계망/.test(title)) s += 5;
  if (/청년/.test(title)) s += 4;
  if (/무료/.test(title)) s += 3;
  return Math.min(s, 99);
}

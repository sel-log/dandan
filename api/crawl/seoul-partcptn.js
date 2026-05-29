/**
 * 단단 크롤러 — 서울시 씽글벙글 참여프로그램
 * 목록: AJAX 프래그먼트 (partcptnListPage.do는 껍데기, 실제 목록은 별도 호출로 주입)
 *   → 후보 엔드포인트를 순서대로 시도해 <tr>이 나오는 곳을 자동 선택
 * 상세: https://1in.seoul.go.kr/front/partcptn/partcptnView.do?partcptn_id={hash}  (SSR)
 *
 * 목록 행 구조:
 *   <td class="num">번호</td>
 *   <td class="f_b">자치구</td>
 *   <td class="title_box"><a href="...partcptnView.do?partcptn_id=HASH" class="title">제목</a></td>
 *   <td>...접수기간 YYYY-MM-DD ~ YYYY-MM-DD</td>
 */

import {
  fetchWithRetry, fetchText, upsertPolicies, mapCategory, normalizeDistrict,
  stripHtml, extractMainText, extractDetailFields, textToConditions, mapWithConcurrency,
} from './_shared.js';

const BASE = 'https://1in.seoul.go.kr';
// 목록 프래그먼트 후보 (행이 나오는 첫 엔드포인트를 사용)
const LIST_ENDPOINTS = [
  '/front/partcptn/partcptnList.do',
  '/front/partcptn/partcptnListPage.do',
];
const MAX_PAGES    = 30;  // 최대 300건 (최신순이라 진행중 프로그램은 앞쪽에 몰림)
const DETAIL_LIMIT = 80;
const DETAIL_CONC  = 6;

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  // 1) 행이 나오는 목록 엔드포인트 자동 탐지 (1페이지로 테스트)
  let endpoint = null;
  for (const ep of LIST_ENDPOINTS) {
    try {
      const html = await fetchText(`${BASE}${ep}?miv_pageNo=1`, { timeout: 9000 });
      if (parseList(html).length) { endpoint = ep; break; }
    } catch { /* 다음 후보 */ }
  }
  if (!endpoint) {
    return res.status(200).json({ success: true, portal: '서울시 씽글벙글 참여프로그램', count: 0, note: '목록 엔드포인트 미발견 (AJAX URL 확인 필요)' });
  }

  // 2) 페이지 순회
  const results = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const html = await fetchText(`${BASE}${endpoint}?miv_pageNo=${page}`, { timeout: 9000 });
      const items = parseList(html);
      if (!items.length) break;
      results.push(...items);
      if (items.length < 10) break;
    } catch (e) {
      console.warn(`서울 참여프로그램 크롤러 오류 [p${page}]:`, e.message);
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

  // 3) 상세 본문 크롤링
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
    endpoint,
    count: deduped.length,
    detail_enriched: detailOk,
  });
}

/** 목록 프래그먼트 파싱 */
function parseList(html) {
  const items = [];
  const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const scope = tbody ? tbody[1] : html;
  const rows  = scope.match(/<tr[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    try {
      // 제목 + partcptn_id
      const a = row.match(/<a[^>]+href="(\/front\/partcptn\/partcptnView\.do\?partcptn_id=([^"&]+))"[^>]*>([\s\S]*?)<\/a>/i);
      if (!a) continue;
      const apply_url = `${BASE}${a[1].replace(/&amp;/g, '&')}`;
      const id = `seoul_partcptn_${a[2]}`;
      const title = stripHtml(a[3]);
      if (!title) continue;

      // 자치구: <td class="f_b">중구</td>
      const guMatch = row.match(/<td[^>]*class="[^"]*f_b[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
      const district = normalizeDistrict('서울', guMatch ? stripHtml(guMatch[1]) : null);

      // 접수기간 셀만 콕 집어 날짜 추출 ('접수기간' 라벨 포함 td, 없으면 4번째 칸)
      const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
      const recvCell = tds.find(t => /접수\s*기간/.test(t)) || tds[3] || '';
      const recvDates = (stripHtml(recvCell).match(/\d{4}-\d{1,2}-\d{1,2}/g) || []);
      const apply_start = recvDates[0] ? toIso(recvDates[0]) : null;
      const apply_end   = recvDates.length >= 2 ? toIso(recvDates[1]) : null;  // 'start ~ ' (open)이면 null
      // 마감 제외 (접수 종료일이 지난 것)
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
        apply_start,
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

function toIso(d) {
  const m = d.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : null;
}

async function fetchDetail(applyUrl) {
  try {
    const html = await fetchText(applyUrl, { timeout: 8000 });
    const text = extractMainText(html, [
      /<div[^>]*class="[^"]*(?:view_cont|view_area|cont_view|board_view|prog_view)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
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
}

function calcScore(title) {
  let s = 92;  // 1인가구 전용 포털
  if (/소셜다이닝|다이닝/.test(title)) s += 4;
  if (/청년/.test(title)) s += 3;
  if (/무료/.test(title)) s += 2;
  return Math.min(s, 99);
}

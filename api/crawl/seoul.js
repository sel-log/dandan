/**
 * 단단 크롤러 — 서울시 씽글벙글 포털
 * https://1in.seoul.go.kr/front/sport/sportListPage.do
 *
 * 카테고리(p_se): SC01=안전, SC02=주거, SC03=경제/일자리, SC04=외로움, SC05=질병, SC06=기타
 * 구별 필터: ver=gu&gu_cd={구코드}
 * 페이지: miv_pageNo=N
 *
 * Vercel Cron: 0 3 * * * (매일 새벽 3시)
 */

import { fetchWithRetry, upsertPolicies, mapCategory, parseDate } from './_shared.js';

const BASE = 'https://1in.seoul.go.kr';
const LIST = `${BASE}/front/sport/sportListPage.do`;
const CATEGORIES = ['SC01','SC02','SC03','SC04','SC05','SC06'];
const CAT_NAME = {
  SC01:'안전', SC02:'주거', SC03:'경제/일자리',
  SC04:'생활·문화', SC05:'건강', SC06:'생활·문화',
};
const MAX_PAGES = 10; // 카테고리당 최대 10페이지 (100건)

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];
  let total = 0;

  for (const se of CATEGORIES) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${LIST}?p_se=${se}&ver=gu&miv_pageNo=${page}`;
      try {
        const r = await fetchWithRetry(url);
        const html = await r.text();
        const items = parseSeoulList(html, se);
        if (!items.length) break; // 빈 페이지 = 끝
        results.push(...items);
        total += items.length;
        if (items.length < 10) break; // 마지막 페이지
      } catch (e) {
        console.warn(`서울 크롤러 오류 [${se} p${page}]:`, e.message);
        break;
      }
    }
  }

  if (results.length) {
    try {
      await upsertPolicies(results);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(200).json({ success: true, portal: '서울시 씽글벙글', count: total });
}

function parseSeoulList(html, se) {
  const items = [];
  // tbody 안의 tr 파싱 (정규식 기반, cheerio 없이)
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return items;

  const rows = tbodyMatch[1].match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    try {
      // 링크 추출
      const linkMatch = row.match(/href="(\/front\/sport\/sportView\.do\?sport_id=[^"]+)"/);
      if (!linkMatch) continue;
      const href = linkMatch[1];
      const apply_url = `${BASE}${href}`;
      const id = `seoul_${href.match(/sport_id=([^&]+)/)?.[1] || Date.now()}`;

      // 제목
      const titleMatch = row.match(/<a[^>]+title="([^"]+)\s*상세 페이지/);
      const title = titleMatch ? titleMatch[1].trim() : '';
      if (!title) continue;

      // 구 이름 (3번째 td)
      const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
        m[1].replace(/<[^>]+>/g, '').trim()
      );
      const district = tds[2] || null; // 관악구, 마포구 등
      const date = parseDate(tds[4] || '');

      items.push({
        id,
        title,
        org: `서울특별시${district ? ' ' + district : ''}`,
        org_type: 'local_gov',
        source_portal: 'https://1in.seoul.go.kr',
        region_city: '서울',
        region_district: district,
        category: CAT_NAME[se] || mapCategory(CAT_NAME[se]),
        benefit_summary: title,
        benefit_detail: '',
        conditions_plain: [],
        apply_steps: [],
        apply_method: 'both',
        apply_url,
        apply_start: null,
        apply_end: date,
        is_recurring: !date,
        match_score: calcScore(title, CAT_NAME[se]),
        target_summary: '',
        tags: [CAT_NAME[se]],
        updated_at: new Date().toISOString(),
      });
    } catch (e) { /* skip malformed row */ }
  }
  return items;
}

function calcScore(title, cat) {
  let s = 75;
  if (/1인가구|1인 가구/.test(title)) s += 20;
  if (/청년/.test(title)) s += 10;
  if (/주거|월세|전세/.test(title)) s += 8;
  if (/취업|일자리|창업/.test(title)) s += 8;
  if (/건강|의료/.test(title)) s += 5;
  return Math.min(s, 99);
}

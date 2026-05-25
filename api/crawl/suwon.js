/**
 * 단단 크롤러 — 수원시 쏘옥 포털
 * https://www.suwon.go.kr/web/board/BD_board.list.do?bbsCd=1407
 *
 * bbsCd=1407: 사업안내 (메인)
 * bbsCd=1448: 주요사업
 * 페이지: q_currPage=N
 *
 * Vercel Cron: 0 3 * * *
 */

import { fetchWithRetry, upsertPolicies, mapCategory, parseDate } from './_shared.js';

const BASE   = 'https://www.suwon.go.kr';
const BOARDS = [
  { bbsCd: '1407', name: '사업안내' },
  { bbsCd: '1448', name: '주요사업' },
];
const MAX_PAGES = 10;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];

  for (const { bbsCd, name } of BOARDS) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${BASE}/web/board/BD_board.list.do?bbsCd=${bbsCd}&q_currPage=${page}`;
      try {
        const r = await fetchWithRetry(url);
        const html = await r.text();
        const items = parseSuwonList(html, bbsCd);
        if (!items.length) break;
        results.push(...items);
        if (items.length < 10) break;
      } catch (e) {
        console.warn(`수원 크롤러 오류 [${name} p${page}]:`, e.message);
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

  return res.status(200).json({ success: true, portal: '수원시 쏘옥', count: results.length });
}

function parseSuwonList(html, bbsCd) {
  const items = [];
  // li.p-media 파싱
  const liMatches = html.match(/<li[^>]*class="[^"]*p-media[^"]*"[^>]*>([\s\S]*?)<\/li>/gi) || [];

  for (const li of liMatches) {
    try {
      // 링크
      const linkMatch = li.match(/href="([^"]*BD_board\.view\.do[^"]*)"/);
      if (!linkMatch) continue;
      const href = linkMatch[1];
      const apply_url = href.startsWith('http') ? href : `${BASE}${href}`;
      const seqMatch  = href.match(/seq=([^&]+)/);
      const id = `suwon_${bbsCd}_${seqMatch?.[1] || Date.now()}`;

      // 제목
      const titleMatch = li.match(/class="[^"]*p-media__heading-text[^"]*"[^>]*>([\s\S]*?)<\/em>/i);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      if (!title) continue;

      // 날짜
      const dateMatch = li.match(/class="[^"]*p-split[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
      const date = parseDate(dateMatch?.[1]?.replace(/<[^>]+>/g, '').trim() || '');

      items.push({
        id,
        title,
        org: '수원시',
        org_type: 'local_gov',
        source_portal: 'https://www.suwon.go.kr/web/1insuwon/index.do',
        region_city: '경기',
        region_district: '수원시',
        category: mapCategory(title),
        benefit_summary: title,
        benefit_detail: '',
        conditions_plain: [],
        apply_steps: [],
        apply_method: 'both',
        apply_url,
        apply_start: null,
        apply_end: date,
        is_recurring: !date,
        match_score: calcScore(title),
        target_summary: '',
        tags: ['수원시'],
        updated_at: new Date().toISOString(),
      });
    } catch (e) { /* skip */ }
  }
  return items;
}

function calcScore(title) {
  let s = 80;
  if (/1인가구|1인 가구/.test(title)) s += 15;
  if (/청년/.test(title)) s += 8;
  if (/주거|월세|전세/.test(title)) s += 6;
  if (/취업|일자리/.test(title)) s += 6;
  return Math.min(s, 99);
}

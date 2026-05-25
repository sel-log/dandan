/**
 * 단단 크롤러 — 성남시 1인가구 포털
 * http://www.seongnam1in.kr/php/board.php?board=program
 *
 * 게시판: program, lecture, document
 * 상세: board.php?board={board}&command=body&no={no}
 * 페이지: board.php?board={board}&page=N
 */

import { fetchWithRetry, upsertPolicies, mapCategory, parseDate } from './_shared.js';

const BASE   = 'http://www.seongnam1in.kr';
const BOARDS = ['program', 'lecture'];
const MAX_PAGES = 5;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];

  for (const board of BOARDS) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${BASE}/php/board.php?board=${board}&page=${page}`;
      try {
        const r = await fetchWithRetry(url, { timeout: 12000 });
        // EUC-KR 처리: TextDecoder로 디코딩
        const buf  = await r.arrayBuffer();
        const html = new TextDecoder('euc-kr').decode(buf);
        const items = parseSeongnamList(html, board);
        if (!items.length) break;
        results.push(...items);
        if (items.length < 10) break;
      } catch (e) {
        console.warn(`성남 크롤러 오류 [${board} p${page}]:`, e.message);
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

  return res.status(200).json({ success: true, portal: '성남시 1인가구', count: results.length });
}

function parseSeongnamList(html, board) {
  const items = [];
  // tr[height='40'] 파싱
  const rows = html.match(/<tr[^>]*height=['"]40['"][^>]*>([\s\S]*?)<\/tr>/gi) || [];

  for (const row of rows) {
    try {
      // 링크 & 번호
      const linkMatch = row.match(/href="board\.php\?board=\w+&command=body&no=(\d+)"/);
      if (!linkMatch) continue;
      const no  = linkMatch[1];
      const id  = `seongnam_${board}_${no}`;
      const apply_url = `${BASE}/php/board.php?board=${board}&command=body&no=${no}`;

      // 제목
      const titleMatch = row.match(/class="subjectColor"[^>]*>[\s\S]*?<span>([\s\S]*?)<\/span>/i);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      if (!title) continue;

      // 날짜
      const dateMatch = row.match(/class="list_date"[^>]*>[\s\S]*?(\d{4}-\d{2}-\d{2})/i);
      const date = parseDate(dateMatch?.[1] || '');

      items.push({
        id,
        title,
        org: '성남시 1인가구지원센터',
        org_type: 'welfare_center',
        source_portal: 'http://www.seongnam1in.kr',
        region_city: '경기',
        region_district: '성남시',
        category: mapCategory(title),
        benefit_summary: title,
        benefit_detail: '',
        conditions_plain: [],
        apply_steps: [],
        apply_method: 'visit',
        apply_url,
        apply_start: null,
        apply_end: date,
        is_recurring: !date,
        match_score: calcScore(title),
        target_summary: '',
        tags: ['성남시', '1인가구'],
        updated_at: new Date().toISOString(),
      });
    } catch (e) { /* skip */ }
  }
  return items;
}

function calcScore(title) {
  let s = 82;
  if (/1인가구|1인 가구/.test(title)) s += 15;
  if (/청년/.test(title)) s += 8;
  if (/주거|복지|건강/.test(title)) s += 5;
  return Math.min(s, 99);
}

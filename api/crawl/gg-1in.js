/**
 * 단단 크롤러 — 경기도 1인가구 포털 참여프로그램
 * API: https://www.gg.go.kr/1ingg/bbs/ajax/boardList.do
 * JSON 응답, 인증 불필요, 크레딧 0원
 */

import { fetchWithRetry, upsertPolicies, mapCategory, parseDate } from './_shared.js';

const API = 'https://www.gg.go.kr/1ingg/bbs/ajax/boardList.do';
const DETAIL_BASE = 'https://www.gg.go.kr/1ingg/bbs/board.do';
const MAX_PAGES = 20; // 최대 160건 (8개/페이지 × 20)

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const body = new URLSearchParams({
        bsIdx: '873',
        menuId: '4112',
        pageIndex: String(page),
        bcIdx: '0',
        searchCondition: 'SUBJECT',
        searchKeyword: '',
        categoryAllYn: 'Y',
        old: '1',
        old1: '0', old2: '0', old3: '0', old4: '0',
        // area 파라미터 (경기도 전체 = area:1, 나머지 0)
        area: '1',
        ...Object.fromEntries(
          Array.from({length: 31}, (_,i) => [`area${i+1}`, '0'])
        ),
        category: '1',
        ...Object.fromEntries(
          Array.from({length: 6}, (_,i) => [`category${i+1}`, '0'])
        ),
      });

      const r = await fetchWithRetry(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const json = await r.json();
      const list = json.resultList || [];
      if (!list.length) break;

      const totalPages = json.paginationInfo?.totalPageCount || 1;

      for (const item of list) {
        // 마감된 항목 제외
        if (item.ADD_COLUMN09 === '마감') continue;

        const id = `gg1in_${item.GNO2}`;
        const title = (item.SUBJECT || '').replace(/<[^>]+>/g, '').trim();
        if (!title) continue;

        // REMARK HTML에서 신청기간·대상 파싱
        const remark = item.REMARK || '';
        const dateMatch = remark.match(/신청기간[^\d]*(\d{4}[.\-]\d{1,2}[.\-]\d{1,2})[^\d~]*[~～]\s*(\d{4}[.\-]\d{1,2}[.\-]\d{1,2})/);
        const apply_end = dateMatch ? parseDate(dateMatch[2]) : parseDate(item.WRITE_DATE2);

        // 신청 URL: ADD_COLUMN06 우선, 없으면 상세 페이지
        const apply_url = item.ADD_COLUMN06
          ? item.ADD_COLUMN06.trim()
          : `${DETAIL_BASE}?bsIdx=873&menuId=4112&boardIdx=${item.GNO2}`;

        // 지역: WRITER_NAME (작성 시군)
        const district = item.WRITER_NAME || null;

        results.push({
          id,
          title,
          org: district ? `경기도 ${district}` : '경기도',
          org_type: 'local_gov',
          source_portal: 'https://www.gg.go.kr/1ingg/bbs/board.do?bsIdx=873&menuId=4112',
          region_city: '경기',
          region_district: district,
          category: mapCategory(title),
          benefit_summary: stripHtml(remark).slice(0, 200) || title,
          benefit_detail: stripHtml(remark).slice(0, 500),
          conditions_plain: parseConditions(remark),
          apply_steps: [],
          apply_method: 'both',
          apply_url,
          apply_start: parseDate(item.WRITE_DATE2),
          apply_end,
          is_recurring: false,
          match_score: calcScore(title),
          target_summary: '1인가구',
          tags: ['1인가구', '경기도', ...(district ? [district] : [])],
          updated_at: new Date().toISOString(),
        });
      }

      if (page >= totalPages) break;
    } catch (e) {
      console.warn(`경기도 1인가구 크롤러 오류 [p${page}]:`, e.message);
      break;
    }
  }

  if (results.length) {
    try { await upsertPolicies(results); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(200).json({ success: true, portal: '경기도 1인가구 참여프로그램', count: results.length });
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/&nbsp;/g, ' ').trim();
}

function parseConditions(remark) {
  const text = stripHtml(remark);
  const conds = [];
  // 대상 추출
  const targetMatch = text.match(/대상\s*[:：]?\s*([^.!\n]{5,80})/);
  if (targetMatch) conds.push(targetMatch[1].trim());
  return conds.slice(0, 3);
}

function calcScore(title) {
  let s = 90; // 1인가구 포털 데이터라 기본점수 높게
  if (/소셜다이닝|다이닝/.test(title)) s += 5;
  if (/청년/.test(title)) s += 5;
  if (/무료/.test(title)) s += 3;
  return Math.min(s, 99);
}

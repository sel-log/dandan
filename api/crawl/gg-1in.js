/**
 * 단단 크롤러 — 경기도 1인가구 포털 참여프로그램
 * 목록 API: https://www.gg.go.kr/1ingg/bbs/ajax/boardList.do (JSON, 인증 불필요)
 * 상세    : https://www.gg.go.kr/1ingg/bbs/boardView.do?bsIdx=873&menuId=4112&bIdx={GNO2}
 */

import {
  fetchWithRetry, fetchText, upsertPolicies, mapCategory, parseDate, normalizeDistrict,
  stripHtml, extractMainText, extractDetailFields, textToConditions, mapWithConcurrency, extractImageUrl,
} from './_shared.js';

const API         = 'https://www.gg.go.kr/1ingg/bbs/ajax/boardList.do';
const DETAIL_VIEW = 'https://www.gg.go.kr/1ingg/bbs/boardView.do';
const DETAIL_BASE = 'https://www.gg.go.kr/1ingg/bbs/board.do';
const ORIGIN       = 'https://www.gg.go.kr';
const MAX_PAGES    = 60;  // 더 깊이 스캔 (마감 건이 많아 접수중이 뒤 페이지에도 섞임)
const PAGE_CONC    = 6;   // 목록 페이지 병렬 fetch
const DETAIL_LIMIT = 150; // 상세 본문·이미지 크롤링 상한
const DETAIL_CONC  = 10;  // 상세 동시 요청 수

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];
  const pageNos = Array.from({ length: MAX_PAGES }, (_, i) => i + 1);

  await mapWithConcurrency(pageNos, PAGE_CONC, async (page) => {
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
        area: '1',
        ...Object.fromEntries(Array.from({length: 31}, (_,i) => [`area${i+1}`, '0'])),
        category: '1',
        ...Object.fromEntries(Array.from({length: 6}, (_,i) => [`category${i+1}`, '0'])),
      });

      const r = await fetchWithRetry(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const json = await r.json();
      const list = json.resultList || [];

      for (const item of list) {
        if (item.ADD_COLUMN09 === '마감') continue;  // 포털 마감 플래그 제외

        const id = `gg1in_${item.GNO2}`;
        const title = (item.SUBJECT || '').replace(/<[^>]+>/g, '').trim();
        if (!title) continue;
        // 1인가구 혜택이 아닌 노이즈 제외 (직원 채용공고·사업 목록 인덱스 글 등)
        if (/(직원|기간제|계약직|공무직|인턴|상담사|매니저)\s*채용|채용\s*(공고|계획|안내)|채용$|사업\s*목록|사업목록|^목록$|선정\s*결과|합격자\s*발표/.test(title)) continue;

        const remark = item.REMARK || '';
        const dateMatch = remark.match(/신청기간[^\d]*(\d{4}[.\-]\d{1,2}[.\-]\d{1,2})[^\d~]*[~～]\s*(\d{4}[.\-]\d{1,2}[.\-]\d{1,2})/);
        // 신청기간이 명시된 경우만 마감일로 사용. 없으면 null(상시) — 글 작성일을 마감일로 쓰지 않음
        const apply_end = dateMatch ? parseDate(dateMatch[2]) : null;

        const apply_url = item.ADD_COLUMN06
          ? item.ADD_COLUMN06.trim()
          : `${DETAIL_VIEW}?bsIdx=873&menuId=4112&bIdx=${item.GNO2}`;

        const district = normalizeDistrict('경기', item.WRITER_NAME);

        results.push({
          gno2: item.GNO2,
          remarkText: stripHtml(remark),
          policy: {
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
            image_url: extractImageUrl(remark, ORIGIN),
            conditions_plain: parseConditionsFromRemark(remark),
            apply_steps: [],
            apply_method: 'both',
            apply_url,
            apply_start: dateMatch ? parseDate(dateMatch[1]) : parseDate(item.WRITE_DATE2),
            apply_end,
            is_recurring: !apply_end,
            match_score: calcScore(title),
            target_summary: '1인가구',
            tags: ['1인가구', '경기도', ...(district ? [district] : [])],
            updated_at: new Date().toISOString(),
          },
        });
      }
    } catch (e) {
      console.warn(`경기도 1인가구 크롤러 오류 [p${page}]:`, e.message);
    }
  });

  // 같은 배치 내 중복 id 제거
  const seen = new Set();
  const deduped = results.filter(r => {
    if (seen.has(r.policy.id)) return false;
    seen.add(r.policy.id);
    return true;
  });

  // ── 상세 본문 크롤링 (Task 3) ──
  let detailOk = 0;
  const targets = deduped.slice(0, DETAIL_LIMIT);
  await mapWithConcurrency(targets, DETAIL_CONC, async (r) => {
    const detail = await fetchDetail(r.gno2);
    if (detail) { enrichWithDetail(r.policy, detail); detailOk++; }
  });

  const policies = deduped.map(r => r.policy);

  if (policies.length) {
    try { await upsertPolicies(policies); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(200).json({
    success: true,
    portal: '경기도 1인가구 참여프로그램',
    count: policies.length,
    detail_enriched: detailOk,
  });
}

/** 상세 페이지 본문 추출 */
async function fetchDetail(gno2) {
  try {
    const url = `${DETAIL_VIEW}?bsIdx=873&menuId=4112&bIdx=${gno2}`;
    const html = await fetchText(url, { timeout: 8000 });
    const text = extractMainText(html, [
      /<div[^>]*class="[^"]*(?:view_cont|board_view|bbs_view|view_area)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
    ]);
    const image = extractImageUrl(html, ORIGIN);
    if ((!text || text.length < 30) && !image) return null;
    return { text: text || '', image, fields: extractDetailFields(text || '') };
  } catch { return null; }
}

/** 상세 결과를 policy에 병합 (기존 값이 빈약할 때만 보강) */
function enrichWithDetail(p, detail) {
  const { text, fields, image } = detail;
  if (image && !p.image_url) p.image_url = image;
  if (text && text.length > (p.benefit_detail || '').length) {
    p.benefit_detail = text.slice(0, 1000);
  }
  if ((!p.benefit_summary || p.benefit_summary === p.title) && text) {
    p.benefit_summary = text.slice(0, 200);
  }
  const conds = text ? textToConditions(text) : [];
  if (conds.length > (p.conditions_plain || []).length) p.conditions_plain = conds;
  if (fields.end) p.apply_end = fields.end;
  if (fields.target) p.target_summary = fields.target.slice(0, 80);
  if (fields.method) p.apply_method = fields.method.slice(0, 60);
}

function parseConditionsFromRemark(remark) {
  const text = stripHtml(remark);
  const conds = [];
  const targetMatch = text.match(/대상\s*[:：]?\s*([^.!\n]{5,80})/);
  if (targetMatch) conds.push(targetMatch[1].trim());
  return conds.slice(0, 3);
}

function calcScore(title) {
  let s = 90;  // 1인가구 포털 데이터라 기본점수 높게
  if (/소셜다이닝|다이닝/.test(title)) s += 5;
  if (/청년/.test(title)) s += 5;
  if (/무료/.test(title)) s += 3;
  return Math.min(s, 99);
}

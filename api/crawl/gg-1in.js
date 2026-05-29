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
const MAX_PAGES    = 25;  // 포털 총 페이지 수(약 25). pageUnit 크게 주면 1페이지로도 충분
const PAGE_CONC    = 6;   // 목록 페이지 병렬 fetch
const DETAIL_LIMIT = 220; // 상세 본문·이미지 크롤링 상한 (포털 전체 ~198개 커버)
const DETAIL_CONC  = 12;  // 상세 동시 요청 수

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];
  const pageNos = Array.from({ length: MAX_PAGES }, (_, i) => i + 1);
  const pageStats = [];          // 진단: 페이지별 결과 수/첫 글번호 (페이지네이션 동작 확인용)
  let jsonKeysSeen = null;

  await mapWithConcurrency(pageNos, PAGE_CONC, async (page) => {
    try {
      const body = new URLSearchParams({
        bsIdx: '873',
        menuId: '4112',
        pageIndex: String(page),
        // 페이지 크기를 크게 지정 — 서버가 받아주면 한 번에 전체를 반환(페이지네이션 미동작 대비)
        pageUnit: '500',
        pageSize: '500',
        recordCountPerPage: '500',
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
      if (!jsonKeysSeen) jsonKeysSeen = Object.keys(json);
      if (page <= 5) pageStats.push({ page, len: list.length, first: list[0]?.GNO2 ?? null });

      for (const item of list) {
        const isClosed = item.ADD_COLUMN09 === '마감';  // 마감도 수집하되 마감 표시(전 시군구 데이터 확보)

        const id = `gg1in_${item.GNO2}`;
        const title = (item.SUBJECT || '').replace(/<[^>]+>/g, '').trim();
        if (!title) continue;
        // 1인가구 혜택이 아닌 노이즈 제외 (직원 채용공고·사업 목록 인덱스 글 등)
        if (/(직원|기간제|계약직|공무직|인턴|상담사|매니저)\s*채용|채용\s*(공고|계획|안내)|채용$|사업\s*목록|사업목록|^목록$|선정\s*결과|합격자\s*발표/.test(title)) continue;

        const remark = item.REMARK || '';
        const dateMatch = remark.match(/신청기간[^\d]*(\d{4}[.\-]\d{1,2}[.\-]\d{1,2})[^\d~]*[~～]\s*(\d{4}[.\-]\d{1,2}[.\-]\d{1,2})/);
        // 신청기간 명시되면 마감일로. 없고 마감 플래그면 작성일(과거)로 마감 처리. 둘 다 없으면 null(상시)
        const apply_end = dateMatch ? parseDate(dateMatch[2])
                        : (isClosed ? (parseDate(item.WRITE_DATE2) || '2020-01-01') : null);

        const apply_url = item.ADD_COLUMN06
          ? item.ADD_COLUMN06.trim()
          : `${DETAIL_VIEW}?bsIdx=873&menuId=4112&bIdx=${item.GNO2}`;

        // 시군구: 작성자명(가족센터) 우선, 없으면 제목의 [○○시가족센터]/[○○구] 표기에서 추출
        const titleBracket = (title.match(/\[([^\]]*[시군구])[^\]]*\]/) || [])[1] || null;
        const district = normalizeDistrict('경기', item.WRITER_NAME)
                      || normalizeDistrict('경기', titleBracket);

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

  // ── 상세 본문 크롤링 (접수중·상시 우선, 마감은 REMARK로 충분) ──
  let detailOk = 0;
  const _today = new Date().toISOString().slice(0, 10);
  deduped.sort((a, b) => {
    const ao = (!a.policy.apply_end || a.policy.apply_end >= _today) ? 0 : 1;
    const bo = (!b.policy.apply_end || b.policy.apply_end >= _today) ? 0 : 1;
    return ao - bo;
  });
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

  const districts = [...new Set(deduped.map(r => r.policy.region_district).filter(Boolean))].sort();

  return res.status(200).json({
    success: true,
    portal: '경기도 1인가구 참여프로그램',
    count: policies.length,
    detail_enriched: detailOk,
    debug: {
      rawCollected: results.length,   // 페이지 전체에서 모은 원본 항목 수(중복 포함)
      uniqueCount: deduped.length,
      districts,                       // 수집된 시군구 목록
      districtCount: districts.length,
      pageStats,                       // 페이지별 결과 수/첫 글번호 (페이지네이션 동작 확인)
      jsonKeys: jsonKeysSeen,          // 목록 API 응답의 최상위 키(페이징 정보 단서)
    },
  });
}

/** 상세 페이지 본문 추출 (내부 게시판) */
async function fetchDetail(gno2) {
  try {
    const url = `${DETAIL_VIEW}?bsIdx=873&menuId=4112&bIdx=${gno2}`;
    const html = await fetchText(url, { timeout: 8000 });

    // 본문 콘텐츠 이미지(attachedImageView) 우선 추출 — 이미지형 게시글의 포스터
    let image = '';
    const aiv = html.match(/<img[^>]+src=["']([^"']*attachedImageView\.do[^"']*)["']/i);
    if (aiv) {
      let src = aiv[1].replace(/&amp;/g, '&').trim();
      if (src.startsWith('//'))         src = 'https:' + src;
      else if (src.startsWith('../'))   src = 'https://www.gg.go.kr/1ingg/' + src.replace(/^(?:\.\.\/)+/, '');
      else if (src.startsWith('/'))     src = ORIGIN + src;
      else if (!/^https?:/i.test(src))  src = 'https://www.gg.go.kr/1ingg/bbs/' + src;
      image = src;
    }
    if (!image) image = extractImageUrl(html, ORIGIN) || '';

    let text = extractMainText(html, [
      /<div[^>]*class="[^"]*(?:view_cont|board_view|bbs_view|view_area)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
    ]) || '';
    // 본문 div를 못 찾아 네비게이션 메뉴를 긁어온 경우 → 텍스트 폐기(좋은 REMARK를 덮어쓰지 않도록)
    if (/본문\s*바로가기[\s\S]*주메뉴\s*바로가기/.test(text)) text = '';

    if ((!text || text.length < 20) && !image) return null;
    return { text, image, fields: extractDetailFields(text) };
  } catch { return null; }
}

/** 상세 결과를 policy에 병합 (기존 값이 빈약할 때만 보강) */
function enrichWithDetail(p, detail) {
  const { text, fields, image } = detail;
  if (image && !p.image_url) p.image_url = image;
  if (text && text.length > (p.benefit_detail || '').length) {
    p.benefit_detail = text.slice(0, 4000);
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

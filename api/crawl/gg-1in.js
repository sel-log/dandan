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
        // 페이지 번호 — 서버가 어떤 이름을 쓰는지 불확실하여 흔한 후보를 모두 전송(서버가 인식하는 것만 사용)
        pageIndex: String(page),
        pageNo: String(page),
        currentPageNo: String(page),
        nowPage: String(page),
        page: String(page),
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
        const isClosed = item.ADD_COLUMN09 === '마감';  // 마감도 포함(모집중>예정>마감). 3개월 윈도우는 앱에서 필터

        const id = `gg1in_${item.GNO2}`;
        let title = (item.SUBJECT || '').replace(/<[^>]+>/g, '').trim();
        if (!title) continue;
        // 1인가구 혜택이 아닌 노이즈 제외 (직원 채용공고·사업 목록 인덱스 글 등) — 원본 제목 기준
        if (/(직원|기간제|계약직|공무직|인턴|상담사|매니저)\s*채용|채용\s*(공고|계획|안내)|채용$|사업\s*목록|사업목록|^목록$|선정\s*결과|합격자\s*발표/.test(title)) continue;

        const remark = item.REMARK || '';
        const remarkText = stripHtml(remark);
        // 약한 제목((1인가구)·(1인가구) (6월) 등)이면 본문에서 실제 프로그램명을 뽑아 보강 (전체 항목 대상)
        if (isWeakTitle(title) && remarkText) {
          const better = deriveTitleFromText(remarkText);
          if (better && better.length >= 4) {
            const monthTag = (title.match(/\(\s*\d{1,2}\s*월\s*\)/) || [])[0] || '';
            title = monthTag ? `${better} ${monthTag}` : better;
          }
        }

        const { start: pStart, end: pEnd } = parseGgPeriod(remark);
        // 시작일: 신청기간 명시 우선, 없으면 작성일(앱 3개월 윈도우용). 종료일: 명시된 경우만(선착순/상시는 null)
        const apply_start = pStart || parseDate(item.WRITE_DATE2);
        const apply_end   = pEnd || (isClosed ? parseDate(item.WRITE_DATE2) : null);

        const apply_url = item.ADD_COLUMN06
          ? item.ADD_COLUMN06.trim()
          : `${DETAIL_VIEW}?bsIdx=873&menuId=4112&bIdx=${item.GNO2}`;

        // 시군구: 작성자명(가족센터) 우선, 없으면 제목의 [○○시가족센터]/[○○구] 표기에서 추출
        const titleBracket = (title.match(/\[([^\]]*[시군구])[^\]]*\]/) || [])[1] || null;
        const district = normalizeDistrict('경기', item.WRITER_NAME)
                      || normalizeDistrict('경기', titleBracket);

        results.push({
          gno2: item.GNO2,
          remarkText,
          policy: {
            id,
            title,
            org: district ? `경기도 ${district}` : '경기도',
            org_type: 'local_gov',
            source_portal: 'https://www.gg.go.kr/1ingg/bbs/board.do?bsIdx=873&menuId=4112',
            region_city: '경기',
            region_district: district,
            category: mapCategory(title),
            benefit_summary: remarkText.slice(0, 200) || title,
            benefit_detail: remarkText.slice(0, 500),
            image_url: extractImageUrl(remark, ORIGIN),
            conditions_plain: parseConditionsFromRemark(remark),
            apply_steps: [],
            apply_method: 'both',
            apply_url,
            apply_start,
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
  // 제목이 카테고리 태그뿐((1인가구) (6월) 등)이면 본문에서 실제 프로그램명을 뽑아 보강
  if (isWeakTitle(p.title) && text) {
    const better = deriveTitleFromText(text);
    if (better && better.length >= 4) {
      // 월(月) 태그가 있으면 유지해서 "프로그램명 (6월)"처럼
      const monthTag = (p.title.match(/\(\s*\d{1,2}\s*월\s*\)/) || [])[0] || '';
      p.title = monthTag ? `${better} ${monthTag}` : better;
    }
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

/** 제목이 카테고리 태그뿐인지: 괄호 그룹·태그어 제거 후 남는 글자가 거의 없으면 약한 제목 */
function isWeakTitle(title) {
  const t = (title || '').replace(/\([^)]*\)/g, ' ')        // (1인가구) (6월) 등 괄호 제거
    .replace(/1인\s*가구|모집|참여자|안내|신청|상시/g, ' ')   // 흔한 태그어 제거
    .replace(/[\s\d월년~\-–—.]/g, '');                       // 숫자·기호 제거
  return t.length < 3;
}

/** 본문 텍스트에서 실제 프로그램명 추출: 앞쪽 이모지/기호 제거 후 첫 일정·라벨·날짜 직전까지 */
function deriveTitleFromText(text) {
  if (!text) return '';
  let t = text.replace(/^[\s\S]*?(?=[가-힣A-Za-z0-9(])/u, '');  // 앞 이모지/공백 제거(첫 글자/괄호까지)
  const cut = t.search(/📅|📆|🗓|⏰|📍|👤|💸|💰|☎|📞|강의\s*기간|운영\s*기간|교육\s*기간|모집\s*기간|신청\s*기간|운영\s*시간|일\s*정\s*기간|일정\s*[:：]|기간\s*[:：]|\d{4}\s*[.\-]\s*\d{1,2}/u);
  if (cut > 4) t = t.slice(0, cut);
  return t.replace(/\s+/g, ' ').trim().replace(/[\s·\-–—:：]+$/u, '').slice(0, 60);
}

function parseConditionsFromRemark(remark) {
  const text = stripHtml(remark);
  const conds = [];
  const targetMatch = text.match(/대상\s*[:：]?\s*([^.!\n]{5,80})/);
  if (targetMatch) conds.push(targetMatch[1].trim());
  return conds.slice(0, 3);
}

/**
 * 신청/모집/접수기간에서 시작일·종료일 추출.
 * - "신청기간 : 2026.05.22.(금) 18:00~ 선착순" → 시작만 (선착순=종료 없음)
 * - "모집기간 2026.06.01 ~ 2026.06.20"       → 시작·종료
 * - "2026. 6. 10. ~ 6. 24."(연도 생략)        → 종료에 시작 연도 상속
 * 못 찾으면 {start:null, end:null}
 */
function parseGgPeriod(remark) {
  const text = stripHtml(remark).replace(/&[a-z]+;/gi, ' ');
  const pad = n => String(n).padStart(2, '0');
  const m = text.match(/(?:신청|모집|접수|참여\s*신청)\s*기간\s*[:：]?\s*([\s\S]{0,50})/);
  const seg = m ? m[1] : '';
  // 완전한 날짜(YYYY/YY . M . D) 토큰들
  const full = [...seg.matchAll(/(\d{2,4})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})/g)];
  if (!full.length) return { start: null, end: null };
  const yr = y => (String(y).length <= 2 ? '20' + String(y).padStart(2, '0') : String(y));
  const start = `${yr(full[0][1])}-${pad(full[0][2])}-${pad(full[0][3])}`;
  let end = null;
  if (full.length >= 2) {
    end = `${yr(full[1][1])}-${pad(full[1][2])}-${pad(full[1][3])}`;
  } else {
    // "~ M. D" 처럼 연도 생략된 종료일 → 시작 연도 상속
    const md = seg.match(/[~～]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})/);
    if (md) end = `${start.slice(0, 4)}-${pad(md[1])}-${pad(md[2])}`;
  }
  // 종료가 시작보다 빠르면(파싱 오류) 버림
  if (end && end < start) end = null;
  return { start, end };
}

function calcScore(title) {
  let s = 90;  // 1인가구 포털 데이터라 기본점수 높게
  if (/소셜다이닝|다이닝/.test(title)) s += 5;
  if (/청년/.test(title)) s += 5;
  if (/무료/.test(title)) s += 3;
  return Math.min(s, 99);
}

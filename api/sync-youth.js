/**
 * 단단 배치 — 온통청년(온라인청년센터) 청년정책 OpenAPI
 * GET /api/sync-youth   (Vercel Cron, 매일 새벽)
 *
 * 소스: https://www.youthcenter.go.kr/go/ythip/getPlcy  (청년정책 목록, JSON)
 *   - 인증키 파라미터: apiKeyNm (구 openApiVlak). 환경변수 YOUTH_API_KEY 사용.
 *   - 페이징: pageNum, pageSize
 *
 * 필터(확정):
 *   - 참여권리 대분류 제외 (1인가구 무용)
 *   - 카테고리 매핑 안 되면 제외
 *   - 기혼 전용(mrgSttsCd=0055001) 제외
 *   - 마감(aplyPrdSeCd=0057003) 제외
 *   - 미성년 대상(최대연령<19 또는 아동·청소년 키워드) 제외
 *   - 시작일 2026 이전 제외. 단 상시(bizPrdSeCd=0056002)는 시작일 없어도 포함(보정안)
 *   - 지역: zipCd 앞2자리로 서울(11)·경기(41)·부산(26)만, 전국구는 '전국'
 *
 * 환경변수:
 *   YOUTH_API_KEY                 = 온통청년 인증키
 *   SUPABASE_URL, SUPABASE_SECRET_KEY (또는 SUPABASE_SERVICE_ROLE_KEY)
 *   CRON_SECRET                   = 크론 인증
 */

import { createClient } from '@supabase/supabase-js';

// 청년정책 목록 API (신규 엔드포인트). 구 youthPlcyList.do도 동작하나 신규 권장.
const API_URL = 'https://www.youthcenter.go.kr/go/ythip/getPlcy';
const PAGE_SIZE = 100;
const MAX_PAGES = 30;          // 안전 상한 (100*30 = 3000건, 현재 전체 ~2600건)

// 단단 지원 광역시·도 (zipCd 앞 2자리)
const SIDO_PREFIX = { '11': '서울', '26': '부산', '41': '경기' };
// 전국구 판단: 시도 prefix 종류가 이 수 이상이면 전국 사업으로 간주
const NATIONWIDE_MIN_PREFIXES = 12;

// 온통청년 중분류(mclsfNm) → 단단 카테고리. 창업→취업. 참여권리 계열은 없음(=제외).
const MCLSF_TO_CAT = {
  '취업': '취업', '재직자': '취업', '창업': '취업',
  '주택 및 거주지': '주거', '기숙사': '주거', '전월세 및 주거급여 지원': '주거',
  '미래역량강화': '교육', '교육비지원': '교육', '온라인교육': '교육',
  '취약계층 및 금융지원': '금융',
  '건강': '건강',
  '예술인지원': '생활·문화', '문화활동': '생활·문화',
};
// 중분류가 매핑표에 없을 때 대분류(lclsfNm)로 폴백. 참여권리는 일부러 누락 → null → 제외.
const LCLSF_FALLBACK = { '일자리': '취업', '주거': '주거', '교육': '교육', '복지문화': '생활·문화', '금융･복지･문화': '금융' };

function mapCategory(p) {
  if (MCLSF_TO_CAT[p.mclsfNm]) return MCLSF_TO_CAT[p.mclsfNm];
  if (LCLSF_FALLBACK[p.lclsfNm]) return LCLSF_FALLBACK[p.lclsfNm];
  return null;
}

function zipToCities(zipCd) {
  if (!zipCd) return [];
  const set = new Set();
  for (const code of String(zipCd).split(',')) {
    const pfx = code.trim().slice(0, 2);
    if (SIDO_PREFIX[pfx]) set.add(SIDO_PREFIX[pfx]);
  }
  return [...set];
}
function isNationwide(zipCd) {
  if (!zipCd) return false;
  const prefixes = new Set(String(zipCd).split(',').map(c => c.trim().slice(0, 2)).filter(Boolean));
  return prefixes.size >= NATIONWIDE_MIN_PREFIXES;
}

function isMinorTarget(p) {
  const maxAge = parseInt(p.sprtTrgtMaxAge || '0', 10);
  const ageLimitYn = p.sprtTrgtAgeLmtYn;   // N=연령제한 적용, Y=제한없음(0~0)
  if (ageLimitYn === 'N' && maxAge > 0 && maxAge < 19) return true;
  const blob = `${p.plcyNm || ''} ${p.plcyExplnCn || ''}`;
  if (/아동|청소년|미성년|초등|중학생|고등학생|영유아/.test(blob)) return true;
  return false;
}

function startYearOk(p) {
  if (p.bizPrdSeCd === '0056002') return true;   // 상시 사업: 시작일 없어도 유효(보정안)
  const bgn = (p.bizPrdBgngYmd || '').trim();
  if (!bgn) return false;                        // 특정기간인데 시작일 없음 → 제외
  const yr = parseInt(bgn.slice(0, 4), 10);
  return yr >= 2026;
}

// YYYYMMDD → YYYY-MM-DD (유효하지 않으면 null)
function fmtDate(s) {
  const t = (s || '').trim();
  if (!/^\d{8}$/.test(t)) return null;
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
}

// 신청기간 문자열(aplyYmd: "YYYYMMDD ~ YYYYMMDD") 파싱
function parseAplyPeriod(p) {
  const raw = (p.aplyYmd || '').trim();
  let start = fmtDate(p.bizPrdBgngYmd);
  let end = fmtDate(p.bizPrdEndYmd);
  const m = raw.match(/(\d{8})\s*~\s*(\d{8})/);
  if (m) { start = fmtDate(m[1]) || start; end = fmtDate(m[2]) || end; }
  return { start, end };
}

function buildDetail(p) {
  const parts = [];
  if (p.plcySprtCn) parts.push(p.plcySprtCn.trim());                 // 지원 내용
  if (p.plcyAplyMthdCn) parts.push('신청방법 : ' + p.plcyAplyMthdCn.trim());
  if (p.sbmsnDcmntCn) parts.push('제출서류 : ' + p.sbmsnDcmntCn.trim());
  if (p.etcMttrCn) parts.push('기타 : ' + p.etcMttrCn.trim());
  const body = parts.join('\n\n');
  return body || p.plcyExplnCn || p.plcyNm || '';
}

function buildConditions(p) {
  const c = [];
  const minA = parseInt(p.sprtTrgtMinAge || '0', 10);
  const maxA = parseInt(p.sprtTrgtMaxAge || '0', 10);
  if (p.sprtTrgtAgeLmtYn === 'N' && (minA || maxA)) c.push(`만 ${minA}~${maxA}세`);
  if (p.mrgSttsCd === '0055002') c.push('미혼 대상');
  if (p.earnEtcCn) c.push(p.earnEtcCn.trim().slice(0, 120));
  if (p.addAplyQlfcCndCn) c.push(p.addAplyQlfcCndCn.trim().slice(0, 200));
  return c.filter(Boolean).slice(0, 6);
}

/* 온통청년 한 건 + 대상 지역 → policies 행 */
function toPolicyRow(p, regionCity, cat) {
  const { start, end } = parseAplyPeriod(p);
  const recurring = p.bizPrdSeCd === '0056002' || !end;
  const idRegion = regionCity === '전국' ? 'nat' : regionCity;
  return {
    id: `youth_${idRegion}_${p.plcyNo}`,
    title: (p.plcyNm || '').trim(),
    org: (p.sprvsnInstCdNm || '').trim() || null,
    org_type: p.pvsnInstGroupCd === '0054001' ? 'government' : 'local_gov',
    source: 'youth',
    source_portal: 'https://www.youthcenter.go.kr',
    region_city: regionCity,
    region_district: null,
    category: cat,
    benefit_summary: (p.plcyExplnCn || p.plcyNm || '').trim().slice(0, 200),
    benefit_detail: buildDetail(p),
    conditions_plain: buildConditions(p),
    apply_method: 'both',
    apply_url: (p.aplyUrlAddr || p.refUrlAddr1 || '').trim() || null,
    apply_start: start,
    apply_end: end,
    is_recurring: recurring,
    is_active: true,
    match_score: 80,
    tags: ['청년', regionCity].filter(Boolean),
  };
}

function shouldInclude(p) {
  if (p.plcyAprvSttsCd && p.plcyAprvSttsCd !== '0044002') return null;   // 승인된 것만
  if (p.lclsfNm === '참여권리') return null;
  const cat = mapCategory(p);
  if (!cat) return null;
  if (p.mrgSttsCd === '0055001') return null;        // 기혼 전용
  if (p.aplyPrdSeCd === '0057003') return null;      // 마감
  if (isMinorTarget(p)) return null;                 // 미성년 대상
  if (!startYearOk(p)) return null;                  // 시작일 2026 이전(상시 예외)
  const nat = isNationwide(p.zipCd);
  const cities = nat ? ['전국'] : zipToCities(p.zipCd);
  if (!cities.length) return null;                   // 서울/경기/부산/전국 외
  return { cities, cat };
}

async function fetchPage(apiKey, pageNum) {
  const params = new URLSearchParams({
    apiKeyNm: apiKey,
    pageNum: String(pageNum),
    pageSize: String(PAGE_SIZE),
    rtnType: 'json',
  });
  const res = await fetch(`${API_URL}?${params.toString()}`, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const result = j.result || j;
  const list = result.youthPolicyList || [];
  const totCount = result.pagging?.totCount ?? result.totCount ?? 0;
  return { list, totCount };
}

export const maxDuration = 300;

export default async function handler(req, res) {
  // ── 크론 인증 (sync-bokjiro와 동일: Authorization: Bearer <CRON_SECRET>) ──
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }
  }

  const apiKey = process.env.YOUTH_API_KEY;
  if (!apiKey) return res.status(500).json({ success: false, error: 'YOUTH_API_KEY 누락' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ success: false, error: 'Supabase env 누락' });
  }
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const byId = new Map();
  const errors = [];
  let scanned = 0, totCount = 0;

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      let pg;
      try { pg = await fetchPage(apiKey, page); }
      catch (e) { errors.push(`page ${page}: ${e.message}`); break; }
      if (page === 1) totCount = pg.totCount;
      if (!pg.list.length) break;
      scanned += pg.list.length;

      for (const p of pg.list) {
        const verdict = shouldInclude(p);
        if (!verdict) continue;
        for (const city of verdict.cities) {
          const row = toPolicyRow(p, city, verdict.cat);
          byId.set(row.id, row);   // 전국구는 nat 하나로 dedup, 지역구는 지역별 분리
        }
      }
      if (scanned >= totCount) break;
    }
  } catch (e) {
    errors.push(`loop: ${e.message}`);
  }

  // Supabase upsert (id 기준 — 숨김보존 트리거가 is_active=false를 지켜줌)
  const rows = [...byId.values()].map(x => ({ ...x, updated_at: new Date().toISOString() }));
  let upserted = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { error } = await supa.from('policies').upsert(chunk, { onConflict: 'id' });
    if (error) errors.push(`upsert: ${error.message}`);
    else upserted += chunk.length;
  }

  return res.status(200).json({
    success: errors.length === 0,
    scanned,
    totCount,
    upserted,
    nationwide: rows.filter(r => r.region_city === '전국').length,
    seoul: rows.filter(r => r.region_city === '서울').length,
    gyeonggi: rows.filter(r => r.region_city === '경기').length,
    busan: rows.filter(r => r.region_city === '부산').length,
    errors,
  });
}

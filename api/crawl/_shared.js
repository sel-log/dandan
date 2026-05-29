/**
 * 단단 크롤러 공유 유틸
 * - fetch with retry / timeout
 * - EUC-KR 등 비-UTF8 응답 디코딩
 * - Supabase upsert helper
 * - 상세 페이지 본문 파싱 공통 함수 (Task 3)
 * - 동시성 제한 매핑
 */

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://fdkgaostxnlurpetswcf.supabase.co';
// Supabase 새 Secret key (sb_secret_...) 또는 레거시 service_role 키 모두 지원
export const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const UA = 'Mozilla/5.0 (compatible; DandanBot/1.0; +https://dandan-ivory.vercel.app)';

/** fetch with 2회 retry + timeout */
export async function fetchWithRetry(url, opts = {}, retries = 2) {
  const timeout = opts.timeout || 10000;
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(url, {
        ...opts,
        headers: { 'User-Agent': UA, ...(opts.headers || {}) },
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return res;
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

/**
 * 응답을 문자열로 디코딩.
 * EUC-KR(부산 등 구형 포털) 응답을 자동 감지해 변환한다.
 * content-type 헤더 또는 본문의 <meta charset>으로 인코딩 판별.
 */
export async function decodeResponse(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  const ctype = (res.headers.get('content-type') || '').toLowerCase();

  let charset = null;
  const ctMatch = ctype.match(/charset=([\w-]+)/);
  if (ctMatch) charset = ctMatch[1].toLowerCase();

  // 헤더에 없으면 본문 앞부분에서 meta charset 탐지
  if (!charset || charset === 'iso-8859-1') {
    const head = buf.slice(0, 2048).toString('latin1').toLowerCase();
    const metaMatch = head.match(/charset\s*=\s*["']?\s*([\w-]+)/);
    if (metaMatch) charset = metaMatch[1].toLowerCase();
  }

  if (charset && (charset.includes('euc-kr') || charset.includes('ks_c') || charset.includes('cp949'))) {
    try { return new TextDecoder('euc-kr').decode(buf); }
    catch { return buf.toString('utf8'); }
  }
  return buf.toString('utf8');
}

/** URL → 디코딩된 HTML 문자열 (EUC-KR 자동 처리) */
export async function fetchText(url, opts = {}) {
  const res = await fetchWithRetry(url, opts);
  return decodeResponse(res);
}

/** Supabase에 policies 배열 upsert */
export async function upsertPolicies(policies) {
  if (!policies.length) return { count: 0 };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/policies`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey': SUPABASE_KEY,
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(policies),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase upsert 실패: ${err}`);
  }
  return { count: policies.length };
}

/** 카테고리 문자열 → 단단 카테고리 */
export function mapCategory(text = '') {
  if (!text) return '생활·문화';
  if (/주거|전세|월세|임차/.test(text))   return '주거';
  if (/일자리|취업|창업|고용/.test(text))  return '취업';
  if (/건강|의료|검진|정신/.test(text))    return '건강';
  if (/금융|대출|서민금융|법률/.test(text)) return '금융';
  if (/교육|학습|훈련|장학/.test(text))    return '교육';
  return '생활·문화';
}

/** 날짜 문자열 정규화 → YYYY-MM-DD or null */
export function parseDate(str) {
  if (!str) return null;
  const m = str.replace(/\./g, '-').match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
}

/* ═══════════════════════════════════════
   상세 페이지 본문 파싱 (Task 3 공통 유틸)
═══════════════════════════════════════ */

/** HTML 태그 제거 → 정돈된 텍스트 */
export function stripHtml(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|tr|br|h\d|td)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * 상세 HTML에서 본문 영역을 best-effort 추출.
 * 게시판마다 컨테이너가 다르므로 흔한 selector를 순서대로 시도하고,
 * 못 찾으면 <body> 전체 텍스트로 폴백한다.
 */
export function extractMainText(html, customRegexes = []) {
  if (!html) return '';
  const candidates = [
    ...customRegexes,
    /<div[^>]*class="[^"]*(?:bbs|board)[-_]?(?:view|content|cont|detail)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
    /<div[^>]*class="[^"]*view[-_]?(?:content|cont|body|txt)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<td[^>]*class="[^"]*(?:content|cont|view)[^"]*"[^>]*>([\s\S]*?)<\/td>/i,
    /<div[^>]*id="[^"]*(?:content|cont|view|board)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
  ];
  for (const re of candidates) {
    const m = re.exec(html);
    if (m && m[1]) {
      const txt = stripHtml(m[1]);
      if (txt.length >= 30) return txt;
    }
  }
  // 폴백: body 전체에서 nav/footer 제거 후 텍스트
  const bodyM = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return stripHtml(bodyM ? bodyM[1] : html);
}

/** 본문 텍스트에서 신청기간/대상/방법/문의 추출 */
export function extractDetailFields(text) {
  const out = { period: null, target: null, method: null, contact: null };
  if (!text) return out;

  const grab = (labels) => {
    for (const label of labels) {
      const re = new RegExp(`${label}\\s*[:：]?\\s*([^\\n]{3,120})`);
      const m = re.exec(text);
      if (m) return m[1].trim().replace(/\s{2,}/g, ' ');
    }
    return null;
  };

  out.period  = grab(['신청\\s*기간', '접수\\s*기간', '모집\\s*기간', '운영\\s*기간', '기간']);
  out.target  = grab(['신청\\s*대상', '모집\\s*대상', '지원\\s*대상', '대상']);
  out.method  = grab(['신청\\s*방법', '접수\\s*방법', '참여\\s*방법', '신청']);
  out.contact = grab(['문의\\s*처', '문의', '연락처']);

  // 기간 → 종료일(YYYY-MM-DD)
  if (out.period) {
    const dates = out.period.match(/\d{4}[.\-]\d{1,2}[.\-]\d{1,2}/g);
    if (dates && dates.length) out.end = parseDate(dates[dates.length - 1]);
  }
  return out;
}

/** 텍스트를 조건 배열로 (불릿/줄 단위) */
export function textToConditions(text, max = 4) {
  if (!text) return [];
  return text
    .split(/[\n❍◆●▶•·○◦\-]+/)
    .map(s => s.trim())
    .filter(s => s.length > 4 && s.length < 120)
    .slice(0, max);
}

/** 동시성 제한 비동기 매핑 (상세 페이지 N개 병렬 처리, 타임아웃 방지) */
export async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      try { out[cur] = await fn(items[cur], cur); }
      catch { out[cur] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

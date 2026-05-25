/**
 * 단단 크롤러 공유 유틸
 * - fetch with retry
 * - Supabase upsert helper
 * - 단단 스키마 변환 공통 함수
 */

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || 'https://fdkgaostxnlurpetswcf.supabase.co';
export const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/** fetch with 2회 retry + timeout */
export async function fetchWithRetry(url, opts = {}, retries = 2) {
  const timeout = opts.timeout || 10000;
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(tid);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return res;
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
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

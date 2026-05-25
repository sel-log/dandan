/**
 * 단단 크롤러 — 경기청년포털
 * https://youth.gg.go.kr/gg/archive-policy-search.do
 *
 * 카테고리별 URL:
 *   전체: archive-policy-search.do?pager.offset=N&pagerLimit=10
 *   주거복지: info/housing-welfare.do?pager.offset=N&pagerLimit=8
 *   일자리: info/job-start-up.do?pager.offset=N&pagerLimit=8
 *   교육: info/education-and-self-development.do?pager.offset=N&pagerLimit=8
 *   금융: info/finance-law.do?pager.offset=N&pagerLimit=8
 */

import { fetchWithRetry, upsertPolicies, mapCategory, parseDate } from './_shared.js';

const BASE = 'https://youth.gg.go.kr';
const ENDPOINTS = [
  { path: '/gg/info/housing-welfare.do',              cat: '주거',    limit: 8 },
  { path: '/gg/info/job-start-up.do',                 cat: '취업',    limit: 8 },
  { path: '/gg/info/education-and-self-development.do', cat: '교육',  limit: 8 },
  { path: '/gg/info/finance-law.do',                  cat: '금융',    limit: 8 },
  { path: '/gg/archive-policy-search.do',             cat: null,     limit: 10 }, // 전체
];
const MAX_OFFSET = 200; // 최대 200건

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];
  const seen = new Set();

  for (const ep of ENDPOINTS) {
    for (let offset = 0; offset <= MAX_OFFSET; offset += ep.limit) {
      const url = `${BASE}${ep.path}?mode=list&pagerLimit=${ep.limit}&pager.offset=${offset}`;
      try {
        const r    = await fetchWithRetry(url);
        const html = await r.text();
        const items = parseGyeonggiYouth(html, ep.cat);
        if (!items.length) break;
        // 중복 제거
        for (const item of items) {
          if (!seen.has(item.id)) { seen.add(item.id); results.push(item); }
        }
        if (items.length < ep.limit) break;
      } catch (e) {
        console.warn(`경기청년 크롤러 오류 [${ep.path} offset=${offset}]:`, e.message);
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

  return res.status(200).json({ success: true, portal: '경기청년포털', count: results.length });
}

function parseGyeonggiYouth(html, defaultCat) {
  const items = [];

  // ul.thum-list li 또는 ul.policy-list li 패턴
  const liPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liPattern.exec(html)) !== null) {
    const li = m[1];
    // arcNo 기반 링크 확인
    const arcMatch = li.match(/arcNo=(\d+)/);
    if (!arcMatch) continue;
    const arcNo = arcMatch[1];
    const id = `gg_youth_${arcNo}`;

    // 제목
    const titleMatch = li.match(/<(?:h5|p)[^>]*>\s*(?:<a[^>]*>)?\s*(?:<span[^>]*>.*?<\/span>)?\s*([\s\S]*?)(?:<\/a>)?\s*<\/(?:h5|p)>/i);
    let title = titleMatch?.[1]?.replace(/<[^>]+>/g, '').trim() || '';
    // [지역명] 제거
    title = title.replace(/^\[[^\]]+\]\s*/, '').trim();
    if (!title) continue;

    // 카테고리
    const catMatch = li.match(/class="[^"]*category[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const cat = catMatch?.[1]?.replace(/<[^>]+>/g,'').trim() || defaultCat || '';

    // 지역 — span.badge.city 만 추출 (상태 배지 제외)
    const regionMatch = li.match(/class="[^"]*badge[^"]*city[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
                     || li.match(/class="city[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const region = regionMatch?.[1]?.replace(/<[^>]+>/g,'').trim() || null;
    // 상태값이 들어온 경우 제외
    const INVALID_DISTRICTS = ['마감','진행','예정','모집중','진행중','신청중','종료'];
    if(region && INVALID_DISTRICTS.includes(region)) continue;

    // 날짜 (모집기간)
    const dateMatch = li.match(/(\d{4}\.\d{2}\.\d{2})\s*~\s*(\d{4}\.\d{2}\.\d{2})/);
    const apply_end = dateMatch ? parseDate(dateMatch[2]) : null;

    // 상태
    const doneMatch = li.match(/class="[^"]*(?:st3|마감)[^"]*"/i);
    if (doneMatch && apply_end) continue; // 마감된 항목 제외

    const apply_url = `${BASE}/gg/archive-policy-search.do?mode=view&arcNo=${arcNo}`;

    items.push({
      id,
      title,
      org: region ? `경기도 ${region}` : '경기도',
      org_type: 'youth_portal',
      source_portal: 'https://youth.gg.go.kr',
      region_city: '경기',
      region_district: region || null,
      category: mapCategory(cat || title),
      benefit_summary: title,
      benefit_detail: '',
      conditions_plain: [],
      apply_steps: [],
      apply_method: 'both',
      apply_url,
      apply_start: null,
      apply_end,
      is_recurring: !apply_end,
      match_score: calcScore(title),
      target_summary: '청년',
      tags: ['청년', '경기도', ...(region ? [region] : [])],
      updated_at: new Date().toISOString(),
    });
  }
  return items;
}

function calcScore(title) {
  let s = 78;
  if (/청년/.test(title)) s += 12;
  if (/주거|월세|전세/.test(title)) s += 8;
  if (/취업|일자리|창업/.test(title)) s += 8;
  if (/금융|대출/.test(title)) s += 5;
  return Math.min(s, 99);
}

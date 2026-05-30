// api/cron/sync-bokjiro.js
// ─────────────────────────────────────────────────────────────
// 단단 일배치: 복지로 데이터를 Supabase `policies` 테이블에 적재.
// 전국 공통 사업(정신건강 심리상담 바우처 등)은 region_city='전국' 한 행으로 합쳐서 저장.
// 피드(loadPolicies)가 .in('region_city',[선택지역,'전국'])로 읽으므로,
// 적재만 해두면 모든 지역 피드에 함께 노출된다. (프론트 B안과 짝)
//
// 실행: Vercel Cron (vercel.json의 crons 참고). 하루 1회.
// 필요 ENV:
//   SUPABASE_URL                  = https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY     = service_role 키 (RLS 우회용, 절대 프론트 노출 금지)
//   CRON_SECRET                   = (선택) 크론 인증용 시크릿
//   PUBLIC_BASE_URL               = (선택) 배포 도메인. 없으면 VERCEL_URL 사용
// 의존성: npm i @supabase/supabase-js
// ─────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

/* 단단이 서비스하는 광역 (복지로를 지역별로 호출) */
const REGIONS = ['서울', '경기', '부산'];

/* 지침 5-3: 1인가구와 무관한 항목 자동 제외 키워드 */
const EXCLUDE = [
  '신혼부부','임신','출산','산모','육아휴직','산후','임산부',
  '한부모','조손','다문화','다자녀','가족센터','입양',
  '어린이집','보육교사','초등학생','청소년','아동','유아','영유아','아이돌봄','아기','신생아',
  '시설 종사자','복지관 종사자','웰빙보조비',
  '화장장려','무연고 사망','추모의집','노숙인 재활시설','이주여성상담',
];
const isExcluded = (text='') => EXCLUDE.some(k => text.includes(k));

/* 전국 공통으로 묶을 사업 규칙: 지역별 응답에 중복으로 떠도 한 행으로 합침 */
const NATIONWIDE_RULES = [
  { key: 'maeum_baucher', re: /(심리상담\s*바우처|전국민\s*마음투자|마음투자\s*지원사업)/, category: '건강' },
];
const matchNationwide = (title='') => NATIONWIDE_RULES.find(r => r.re.test(title)) || null;

/* 복지로 응답에 없더라도 무조건 보장 적재할 전국 공통 사업 (큐레이션 시드).
   → 정신건강 심리상담 바우처는 fetch 누락과 무관하게 항상 노출되도록 시드로 박아둠. */
const SEED_NATIONWIDE = [
  {
    id: 'bokjiro_nat_maeum_baucher',
    title: '정신건강 심리상담 바우처 (구 전국민 마음투자 지원사업)',
    org: '보건복지부',
    org_type: 'government',
    source: 'bokjiro',
    source_portal: 'https://www.bokjiro.go.kr',
    region_city: '전국',
    region_district: null,
    category: '건강',
    benefit_summary: '우울·불안 등 마음이 힘들 때, 전문 심리상담 8회를 바우처로 지원받아요.',
    benefit_detail:
      '대화 기반 전문 심리상담 서비스를 총 8회(1회 50분 이상, 1:1 대면) 이용할 수 있는 바우처를 제공합니다. ' +
      '바우처 단가는 1회 7~8만원이며, 본인부담금은 소득 수준에 따라 회당 0원~최대 24,000원으로 차등 적용됩니다. ' +
      '바우처 생성일로부터 120일 안에 사용해야 합니다.',
    conditions_plain: [
      '나이·소득 제한 없음 (혼자 살아도 OK)',
      '정신건강복지센터·대학상담센터·정신과 등에서 받은 의뢰서/소견서 필요',
      '온라인 신청은 만 19세 이상 본인만 가능',
    ],
    apply_method: 'both',
    apply_url: 'https://www.bokjiro.go.kr/ssis-tbu/twataa/wlfareInfo/moveTWAT52011M.do?wlfareInfoId=WLF00005567',
    apply_start: '2026-01-01',
    apply_end: '2026-12-31',
    is_recurring: true,
    is_active: true,
    match_score: 88,
    tags: ['심리상담', '마음건강', '바우처', '전국'],
  },
];

/* 복지로 한 건 → policies 스키마 행으로 정규화 */
function toPolicyRow(r) {
  const nat = matchNationwide(r.title || '');
  const baseId = r.id || ('h' + Buffer.from(`${r.title}|${r.org || ''}`).toString('base64').slice(0, 16));
  if (nat) {
    // 전국 공통: 지역 무관 고정 id로 묶음 (지역별 중복 → 한 행)
    return {
      id: `bokjiro_nat_${nat.key}`,
      title: r.title,
      org: r.org || '보건복지부',
      org_type: 'government',
      source: 'bokjiro',
      source_portal: r.source_portal || 'https://www.bokjiro.go.kr',
      region_city: '전국',
      region_district: null,
      category: nat.category || r.category || '건강',
      benefit_summary: r.benefit_summary || r.title,
      benefit_detail: r.benefit_detail || r.benefit_summary || '',
      conditions_plain: Array.isArray(r.conditions_plain) ? r.conditions_plain : [],
      apply_method: r.apply_method || 'both',
      apply_url: r.apply_url || null,
      apply_start: r.apply_start || null,
      apply_end: r.apply_end || null,
      is_recurring: r.is_recurring ?? !r.apply_end,
      is_active: true,
      match_score: r.match_score || 85,
      tags: r.tags || [],
    };
  }
  // 일반 복지로 행: 지역 그대로 유지, source=bokjiro 로 태깅
  return {
    id: `bokjiro_${r.region_city || ''}_${baseId}`,
    title: r.title,
    org: r.org || null,
    org_type: r.org_type || 'local_gov',
    source: 'bokjiro',
    source_portal: r.source_portal || 'https://www.bokjiro.go.kr',
    region_city: r.region_city,
    region_district: r.region_district || null,
    category: r.category || '생활·문화',
    benefit_summary: r.benefit_summary || r.title,
    benefit_detail: r.benefit_detail || r.benefit_summary || '',
    conditions_plain: Array.isArray(r.conditions_plain) ? r.conditions_plain : [],
    apply_method: r.apply_method || 'both',
    apply_url: r.apply_url || null,
    apply_start: r.apply_start || null,
    apply_end: r.apply_end || null,
    is_recurring: r.is_recurring ?? !r.apply_end,
    is_active: true,
    match_score: r.match_score || 75,
    tags: r.tags || [],
  };
}

export default async function handler(req, res) {
  // ── 크론 인증 (Vercel Cron은 Authorization: Bearer <CRON_SECRET> 전송) ──
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${secret}`) {
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ success: false, error: 'Supabase env 누락' });
  }
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const base =
    (process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.replace(/\/$/, '')) ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');

  const byId = new Map();      // id → row (전국 사업 자동 dedup)
  const errors = [];

  // 1) 시드(전국 공통)는 무조건 적재
  for (const s of SEED_NATIONWIDE) byId.set(s.id, s);

  // 2) 지역별로 기존 /api/policies(복지로) 재사용해서 수집
  if (base) {
    for (const city of REGIONS) {
      try {
        const r = await fetch(`${base}/api/policies?city=${encodeURIComponent(city)}`);
        const j = await r.json();
        if (!r.ok || !j?.policies?.length) continue;
        for (const p of j.policies) {
          // 제목·요약·상세 어디든 제외 키워드가 있으면 스킵
          const blob = `${p.title || ''} ${p.benefit_summary || ''} ${p.benefit_detail || ''}`;
          if (isExcluded(blob)) continue;
          const row = toPolicyRow(p);
          byId.set(row.id, row);  // 같은 전국 id면 마지막 것으로 덮어씀(=합쳐짐)
        }
      } catch (e) {
        errors.push(`${city}: ${e.message}`);
      }
    }
  } else {
    errors.push('base URL 미설정 — 시드만 적재됨 (PUBLIC_BASE_URL 또는 VERCEL_URL 확인)');
  }

  // 3) Supabase upsert (id 기준 — 매일 돌려도 중복 없이 갱신)
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
    upserted,
    nationwide: rows.filter(r => r.region_city === '전국').length,
    regional: rows.filter(r => r.region_city !== '전국').length,
    errors,
  });
}

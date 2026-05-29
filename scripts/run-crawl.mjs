/**
 * 단단 크롤 진입점 (GitHub Actions / 로컬 CLI 공용)
 *
 * 기존 Vercel 핸들러(api/crawl/run.js)를 그대로 재사용한다.
 * mock req/res로 호출 → 서울·경기·부산 크롤 후 Supabase upsert.
 *
 * 필요 env (GitHub Secrets):
 *   - SUPABASE_URL          (없으면 _shared.js 기본값 사용)
 *   - SUPABASE_SECRET_KEY   (Supabase secret/service 키 — 쓰기 권한 필요)
 *   - CRON_SECRET           (핸들러 인증용 — Vercel과 동일 값)
 *
 * 실행: node scripts/run-crawl.mjs
 */

import runHandler from '../api/crawl/run.js';

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

if (!process.env.SUPABASE_SECRET_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  fail('SUPABASE_SECRET_KEY(또는 SUPABASE_SERVICE_ROLE_KEY) 환경변수가 없습니다. GitHub Secrets를 확인하세요.');
}

const req = {
  method: 'GET',
  query: {},
  // run.js는 x-cron-secret === process.env.CRON_SECRET 이면 통과
  headers: { 'x-cron-secret': process.env.CRON_SECRET || '' },
};

let statusCode = 200;
let payload = null;
const res = {
  status(code) { statusCode = code; return this; },
  json(data)   { payload = data;   return this; },
};

const startedAt = new Date().toISOString();
console.log(`▶ 단단 크롤 시작 — ${startedAt}`);

try {
  await runHandler(req, res);
} catch (e) {
  fail(`크롤 핸들러 예외: ${e?.stack || e?.message || e}`);
}

console.log(JSON.stringify(payload, null, 2));

if (statusCode !== 200 || !payload?.success) {
  fail(`크롤 실패 (status ${statusCode})`);
}

// 포털별 부분 실패는 경고만 남기고 전체 작업은 성공 처리 (한 포털 장애가 전체를 막지 않도록)
const failedPortals = (payload.results || []).filter((r) => r.error);
if (failedPortals.length) {
  console.warn('⚠ 일부 포털 실패:', failedPortals.map((r) => `${r.portal}(${r.error})`).join(' | '));
}

const ok = (payload.results || []).filter((r) => !r.error);
console.log(`✅ 완료 — ${payload.total_upserted}건 저장, 성공 포털 ${ok.length}/${(payload.results || []).length}, 소요 ${payload.elapsed}`);

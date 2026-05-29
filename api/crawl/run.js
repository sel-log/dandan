/**
 * 단단 마스터 크롤러
 * GET /api/crawl/run
 *
 * Vercel Cron으로 매일 새벽 3시 자동 실행
 * 수동 실행: /api/crawl/run?secret=CRON_SECRET
 *
 * 광역시·도 단위 운영 — 서울·경기(MVP1) + 인천·부산(MVP2)
 */

// 함수 최대 실행 시간 (풀 크롤 ~80s) — Pro 최대 300s, Hobby는 60s로 자동 캡
export const maxDuration = 300;

// 동적 import: 한 크롤러 모듈이 깨져도 전체 함수가 죽지 않고 해당 포털만 에러 처리
const CRAWLERS = [
  { name: '서울시 씽글벙글 참여프로그램', path: './seoul-partcptn.js' },
  { name: '경기도 1인가구 참여프로그램',  path: './gg-1in.js' },
  { name: '인천 1인가구 포털',           path: './incheon.js' },
  { name: '부산 1인가구 지원센터',        path: './busan.js' },
];

export default async function handler(req, res) {
  // 인증 확인 (Vercel Cron 또는 수동)
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];
  const startTime = Date.now();

  for (const { name, path } of CRAWLERS) {
    try {
      const mod = await import(path);          // 모듈 로드 실패도 여기서 잡힘
      const crawl = mod.default;
      const mockReq = {
        method: 'GET',
        query: req.query,
        headers: { 'x-cron-secret': process.env.CRON_SECRET },
      };
      const mockRes = {
        _data: null,
        _status: 200,
        status(code) { this._status = code; return this; },
        json(data) { this._data = data; return this; },
      };
      await crawl(mockReq, mockRes);
      results.push({ portal: name, ...mockRes._data, status: mockRes._status });
    } catch (e) {
      results.push({ portal: name, error: e.message, status: 500 });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalCount = results.reduce((s, r) => s + (r.count || 0), 0);

  return res.status(200).json({
    success: true,
    elapsed: `${elapsed}s`,
    total_upserted: totalCount,
    results,
    ran_at: new Date().toISOString(),
  });
}

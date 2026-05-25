/**
 * 단단 마스터 크롤러
 * GET /api/crawl/run
 *
 * Vercel Cron으로 매일 새벽 3시 자동 실행
 * 수동 실행: /api/crawl/run?secret=CRON_SECRET
 */

import seoulHandler      from './seoul.js';
import seoulPartcptnHandler from './seoul-partcptn.js';
import suwonHandler      from './suwon.js';
import seongnamHandler   from './seongnam.js';
import ggYouthHandler    from './gg-youth.js';
import gg1inHandler      from './gg-1in.js';

const CRAWLERS = [
  { name: '서울시 참여프로그램',       handler: seoulPartcptnHandler },  // ← 최우선
  { name: '경기도 1인가구 참여프로그램', handler: gg1inHandler },          // ← 최우선
  { name: '서울시 씽글벙글 지원사업',   handler: seoulHandler },
  { name: '수원시 쏘옥',              handler: suwonHandler },
  { name: '성남시 1인가구',           handler: seongnamHandler },
  { name: '경기청년포털',             handler: ggYouthHandler },
];

export default async function handler(req, res) {
  // 인증 확인 (Vercel Cron 또는 수동)
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: '인증 필요' });
  }

  const results = [];
  const startTime = Date.now();

  for (const { name, handler: crawl } of CRAWLERS) {
    try {
      // 각 크롤러를 mock req/res로 실행
      const mockRes = {
        _data: null,
        _status: 200,
        status(code) { this._status = code; return this; },
        json(data) { this._data = data; return this; },
      };
      await crawl(req, mockRes);
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

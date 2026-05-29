/**
 * 단단 — 복지로 지자체복지서비스 API 프록시
 * GET /api/policies?city=서울
 * 광역시·도 단위로만 운영 (시·군·구 필터 미사용)
 * Vercel 환경변수: BOKJIRO_API_KEY
 */

const SIDO_CODE = {
  '서울':'11','경기':'41','인천':'28','부산':'26',
};

const SIDO_NM = {
  '서울':'서울특별시','경기':'경기도','인천':'인천광역시','부산':'부산광역시',
};

const EXCLUDE_KEYWORDS = [
  // 결혼·임신·출산·육아 관련
  '신혼부부','임신','출산','산모','육아휴직','육아기','태아','분만',
  '산후','모유','임산부',
  // 가족 단위 (2인 이상 전제)
  '한부모가족','한부모 가족','조손가족','다문화가족','다자녀',
  '가족센터','입양','위탁아동',
  // 아동·아이·미성년자 전용
  '어린이집','보육교사','보육교직원','초등학생','청소년','아동',
  '유아','영유아','방과후','어린이 급식','어린이·청소년','학교급식',
  '입학축하','수학여행','돌봄교실','아이돌봄','아이 돌봄',
  '아기','영아','신생아','임산','태교','어린이날',
  // 시설 종사자 수당 (개인 수혜 아님)
  '시설 종사자','복지관 종사자','웰빙보조비','종사자 처우',
  // 완전히 무관한 항목
  '화장장려','무연고 사망','추모의집','노숙인 재활시설 기능보강',
  '이주여성상담','일본군',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if(req.method === 'OPTIONS'){ res.status(200).end(); return; }

  const { city, life, theme, page = '1', size = '30' } = req.query;
  const apiKey = process.env.BOKJIRO_API_KEY;

  if(!apiKey) return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });
  if(!city)   return res.status(400).json({ error: 'city 파라미터가 필요합니다.' });

  const sidoCd = SIDO_CODE[city];
  if(!sidoCd) return res.status(400).json({ error: `지원하지 않는 지역: ${city}` });

  // 제외 키워드로 걸러질 항목을 감안해 넉넉히 받아온 뒤 size로 자름
  const fetchSize = parseInt(size) * 4;

  const params = new URLSearchParams({
    serviceKey: apiKey,
    callTp:    'L',
    pageNo:    page,
    numOfRows: String(fetchSize),
    siDoCd:    sidoCd,
  });
  if(life)  params.append('lifeArray',       life);
  if(theme) params.append('intrsThemaArray', theme);

  const url = `http://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations/LcgvWelfarelist?${params}`;

  try {
    const upstream = await fetch(url);
    if(!upstream.ok) throw new Error(`복지로 HTTP ${upstream.status}`);
    const xml = await upstream.text();

    const total = parseInt(getXmlVal(xml, 'totalCount') || '0');
    const blocks = [];
    const re = /<servList>([\s\S]*?)<\/servList>/g;
    let m;
    while((m = re.exec(xml)) !== null) blocks.push(m[1]);

    const sidoNm = SIDO_NM[city];

    const all = blocks.map(block => {
      const get = tag => getXmlVal(block, tag) || '';
      return {
        id:              get('servId'),
        title:           get('servNm'),
        org:             get('bizChrDeptNm') || get('ctpvNm'),
        org_type:        'local_gov',
        source_portal:   get('servDtlLink'),
        region_city:     city,
        region_district: get('sggNm') || null,  // 백엔드 보존용 (UI 미노출)
        ctpvNm:          get('ctpvNm'),
        category:        mapThemeNm(get('intrsThemaNmArray')),
        benefit_summary: cleanText(get('servDgst')) || get('servNm'),
        benefit_detail:  cleanText(get('servDgst')),
        conditions_plain: parseConditions(get('alwServCn') || get('servDgst')),
        apply_method:    get('aplyMtdNm') || '-',
        apply_url:       get('servDtlLink') || null,
        apply_end:       get('rcvPeriodCn') || null,
        is_recurring:    !get('rcvPeriodCn'),
        match_score:     calcMatchScore(get('servNm'), get('servDgst'), get('lifeNmArray')),
        target_summary:  get('lifeNmArray') || get('tgterIndvdlNmArray') || '',
        tags:            [],
      };
    });

    // ── 1단계: 시도 필터 ──
    let filtered = all.filter(p => {
      if(!p.ctpvNm) return true;
      return p.ctpvNm.includes(sidoNm) || p.ctpvNm.includes(city);
    });

    // ── 2단계: 1인가구 무관 항목 제외 ──
    filtered = filtered.filter(p => {
      const text = p.title + ' ' + p.benefit_summary;
      return !EXCLUDE_KEYWORDS.some(kw => text.includes(kw));
    });

    // ── 3단계: match_score 내림차순 정렬 ──
    filtered.sort((a, b) => b.match_score - a.match_score);

    // 임시 필드(ctpvNm) 제거 후 size만큼 자름
    const policies = filtered.slice(0, parseInt(size)).map(({ ctpvNm, ...rest }) => rest);

    return res.status(200).json({
      success: true,
      total,
      page: parseInt(page),
      size: policies.length,
      city,
      policies,
    });

  } catch(e) {
    console.error('복지로 API 실패:', e.message);
    return res.status(502).json({ error: '복지로 API 호출 실패', message: e.message });
  }
}

function calcMatchScore(title, desc, lifeNm) {
  let score = 75;
  const text = (title + ' ' + desc + ' ' + lifeNm).toLowerCase();
  if(text.includes('1인가구') || text.includes('1인 가구')) score += 20;
  if(text.includes('청년'))    score += 10;
  if(text.includes('주거') || text.includes('월세') || text.includes('전세')) score += 8;
  if(text.includes('취업') || text.includes('일자리') || text.includes('창업')) score += 8;
  if(text.includes('건강') || text.includes('의료') || text.includes('검진')) score += 5;
  if(text.includes('저소득') || text.includes('기초') || text.includes('차상위')) score += 5;
  return Math.min(score, 99);
}

function getXmlVal(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
  return m ? m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim() : null;
}

function cleanText(text) {
  if(!text) return '';
  return text.replace(/❍|◆|●|▶|•/g,'').replace(/\s+/g,' ').trim().slice(0,200);
}

function mapThemeNm(nm) {
  if(!nm) return '생활·문화';
  if(nm.includes('주거'))                                              return '주거';
  if(nm.includes('일자리'))                                            return '취업';
  if(nm.includes('건강'))                                              return '건강';
  if(nm.includes('금융')||nm.includes('서민금융')||nm.includes('법률')) return '금융';
  if(nm.includes('교육')||nm.includes('보육'))                         return '교육';
  return '생활·문화';
}

function parseConditions(text) {
  if(!text) return [];
  return text
    .split(/[\n❍◆●▶•\-○◦]+/)
    .map(s => s.trim())
    .filter(s => s.length > 4)
    .slice(0, 4);
}

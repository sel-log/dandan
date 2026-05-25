/**
 * 단단 — 복지로 지자체복지서비스 API 프록시
 * GET /api/policies?city=서울&district=마포구
 * Vercel 환경변수: BOKJIRO_API_KEY
 */

const SIDO_CODE = {
  '서울':'11','경기':'41','인천':'28','부산':'26',
};

const SIDO_NM = {
  '서울':'서울특별시','경기':'경기도','인천':'인천광역시','부산':'부산광역시',
};

const SIGUNGU_CODE = {
  '강남구':'11680','강동구':'11740','강북구':'11305','강서구':'11500',
  '관악구':'11620','광진구':'11215','구로구':'11530','금천구':'11545',
  '노원구':'11350','도봉구':'11320','동대문구':'11230','동작구':'11590',
  '마포구':'11440','서대문구':'11410','서초구':'11650','성동구':'11200',
  '성북구':'11290','송파구':'11710','양천구':'11470','영등포구':'11560',
  '용산구':'11170','은평구':'11380','종로구':'11110','중구':'11140','중랑구':'11260',
  '성남시 분당구':'41135','성남시 수정구':'41111','성남시 중원구':'41113',
  '수원시 권선구':'41113','수원시 영통구':'41117','수원시 장안구':'41111','수원시 팔달구':'41115',
  '계양구':'28245','미추홀구':'28177','남동구':'28200','동구':'28140',
  '부평구':'28237','서구':'28260','연수구':'28185',
  '금정구':'26410','남구':'26290','동래구':'26260','부산진구':'26230',
  '북구':'26330','사상구':'26530','사하구':'26380','수영구':'26500',
  '연제구':'26470','영도구':'26200','해운대구':'26350',
};

// 1인가구가 절대 해당 안 되는 항목만 제외
// (결혼/출산/육아 전제 혜택, 시설 종사자 수당 등)
const EXCLUDE_KEYWORDS = [
  '신혼부부','육아휴직','출산 장려','입양 장려','다자녀','임신',
  '어린이집 운영','보육교사','노숙인시설 종사자','화장장려',
  '무연고 사망','추모의집',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if(req.method === 'OPTIONS'){ res.status(200).end(); return; }

  const { city, district, life, theme, page = '1', size = '30' } = req.query;
  const apiKey = process.env.BOKJIRO_API_KEY;

  if(!apiKey) return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });
  if(!city)   return res.status(400).json({ error: 'city 파라미터가 필요합니다.' });

  const sidoCd    = SIDO_CODE[city];
  const sigunguCd = district ? SIGUNGU_CODE[district] : undefined;
  if(!sidoCd) return res.status(400).json({ error: `지원하지 않는 지역: ${city}` });

  // 넉넉히 가져와서 필터 후 반환
  const fetchSize = parseInt(size) * 4;

  const params = new URLSearchParams({
    serviceKey: apiKey,
    callTp:    'L',
    pageNo:    page,
    numOfRows: String(fetchSize),
    siDoCd:    sidoCd,
  });
  if(sigunguCd) params.append('siGunGuCd',      sigunguCd);
  if(life)      params.append('lifeArray',       life);
  if(theme)     params.append('intrsThemaArray', theme);

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
        region_district: district || (get('sggNm') || null),
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

    // 1. 해당 시도 데이터만 (복지로 API 지역 필터 불완전 보완)
    const regionFiltered = all.filter(p => {
      if(!p.ctpvNm) return true;
      return p.ctpvNm.includes(sidoNm) || p.ctpvNm.includes(city);
    });

    // 2. 1인가구 해당 없는 항목만 제외 (최소한으로)
    const filtered = regionFiltered.filter(p => {
      const text = p.title + ' ' + p.benefit_summary;
      return !EXCLUDE_KEYWORDS.some(kw => text.includes(kw));
    });

    // 3. match_score 높은 순 정렬
    filtered.sort((a, b) => b.match_score - a.match_score);

    // ctpvNm 임시 필드 제거 후 반환
    const policies = filtered.slice(0, parseInt(size)).map(({ ctpvNm, ...rest }) => rest);

    return res.status(200).json({
      success: true,
      total,
      page: parseInt(page),
      size: policies.length,
      city,
      district: district || null,
      policies,
    });

  } catch(e) {
    console.error('복지로 API 실패:', e.message);
    return res.status(502).json({ error: '복지로 API 호출 실패', message: e.message });
  }
}

// 1인가구 관련성 점수 계산
function calcMatchScore(title, desc, lifeNm) {
  let score = 75;
  const text = (title + ' ' + desc + ' ' + lifeNm).toLowerCase();

  // 1인가구 직접 언급 → 최고점
  if(text.includes('1인가구') || text.includes('1인 가구')) score += 20;
  // 청년 관련
  if(text.includes('청년'))    score += 10;
  // 주거/취업/건강 주요 카테고리
  if(text.includes('주거') || text.includes('월세') || text.includes('전세')) score += 8;
  if(text.includes('취업') || text.includes('일자리') || text.includes('창업')) score += 8;
  if(text.includes('건강') || text.includes('의료') || text.includes('검진')) score += 5;
  // 저소득/복지 기본
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
  if(nm.includes('주거'))                                          return '주거';
  if(nm.includes('일자리'))                                        return '취업';
  if(nm.includes('건강'))                                          return '건강';
  if(nm.includes('금융')||nm.includes('서민금융')||nm.includes('법률')) return '금융';
  if(nm.includes('교육')||nm.includes('보육'))                     return '교육';
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

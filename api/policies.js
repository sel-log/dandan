/**
 * 단단 — 복지로 지자체복지서비스 API 프록시
 * GET /api/policies?city=서울&district=성남시 분당구
 * Vercel 환경변수: BOKJIRO_API_KEY
 */

const SIDO_CODE = {
  '서울':'11','경기':'41','인천':'28','부산':'26',
};

const SIDO_NM = {
  '서울':'서울특별시','경기':'경기도','인천':'인천광역시','부산':'부산광역시',
};

// 시군구 코드 (복지로 API용)
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

// district 값에서 시군 이름 추출 (응답 sggNm 매칭용)
// '성남시 분당구' → '성남시', '마포구' → '마포구', '수원시 팔달구' → '수원시'
function extractSigunNm(district) {
  if(!district) return null;
  const parts = district.trim().split(/\s+/);
  // '성남시 분당구' 처럼 시+구 형태면 앞의 '시'를 반환
  if(parts.length >= 2 && parts[0].endsWith('시')) return parts[0];
  // '마포구' 처럼 구만 있으면 그대로
  return parts[0];
}

const EXCLUDE_KEYWORDS = [
  // 결혼·임신·출산·육아 관련
  '신혼부부','임신','출산','산모','육아휴직','육아기','태아','분만',
  '산후','모유','임산부',
  // 가족 단위 (2인 이상 전제)
  '한부모가족','한부모 가족','조손가족','다문화가족','다자녀',
  '가족센터','입양','위탁아동',
  // 미성년자 전용
  '어린이집','보육교사','보육교직원','초등학생','청소년','아동',
  '유아','영유아','방과후','어린이 급식','어린이·청소년','학교급식',
  '입학축하','수학여행','돌봄교실',
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

  const { city, district, life, theme, page = '1', size = '30' } = req.query;
  const apiKey = process.env.BOKJIRO_API_KEY;

  if(!apiKey) return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });
  if(!city)   return res.status(400).json({ error: 'city 파라미터가 필요합니다.' });

  const sidoCd    = SIDO_CODE[city];
  const sigunguCd = district ? SIGUNGU_CODE[district] : undefined;
  if(!sidoCd) return res.status(400).json({ error: `지원하지 않는 지역: ${city}` });

  const fetchSize = parseInt(size) * 12;

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

    const sidoNm  = SIDO_NM[city];
    // district 있을 때: 시군 이름 추출 ('성남시 분당구' → '성남시')
    const sigunNm = district ? extractSigunNm(district) : null;

    const all = blocks.map(block => {
      const get = tag => getXmlVal(block, tag) || '';
      return {
        id:              get('servId'),
        title:           get('servNm'),
        org:             get('bizChrDeptNm') || get('ctpvNm'),
        org_type:        'local_gov',
        source_portal:   get('servDtlLink'),
        region_city:     city,
        region_district: get('sggNm') || null,
        ctpvNm:          get('ctpvNm'),
        sggNm:           get('sggNm'),
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

    // ── 2단계: 시군구 필터 (district 선택 시) ──
    // 복지로 API는 sggNm이 자주 비어있어서 org(기관명)에서 시군 추출
    // 통과 조건:
    //   A) sggNm도 없고 org에도 다른 시군 언급 없음 → 경기도 광역 혜택 → 통과
    //   B) sggNm 또는 org가 선택한 시군 포함 → 해당 시군 혜택 → 통과
    //   C) 다른 시군 데이터 → 제외
    if(sigunNm) {
      // 경기도 내 다른 시군 목록 — 선택한 시군 제외하고 나머지 전부
      const ALL_GYEONGGI = [
        '수원시','성남시','용인시','부천시','안산시','남양주시','화성시','평택시',
        '고양시','의정부시','시흥시','파주시','광명시','김포시','광주시','군포시',
        '오산시','이천시','안성시','의왕시','하남시','양주시','구리시','포천시',
        '여주시','동두천시','안양시','가평군','양평군','연천군',
      ];
      const ALL_INCHEON = ['계양구','미추홀구','남동구','부평구','연수구','서구','동구','중구'];
      const ALL_BUSAN   = ['해운대구','부산진구','동래구','사상구','사하구','수영구',
                           '금정구','남구','동구','영도구','연제구','강서구','북구'];
      const OTHER_SIGUN = [...ALL_GYEONGGI,...ALL_INCHEON,...ALL_BUSAN]
        .filter(s => !s.includes(sigunNm) && !sigunNm.includes(s));

      filtered = filtered.filter(p => {
        const orgText = p.org || '';
        const sgg     = p.sggNm || '';

        // sggNm 또는 org가 선택 시군 포함 → 통과 (B)
        if(sgg.includes(sigunNm) || orgText.includes(sigunNm)) return true;

        // 다른 시군이 org에 명시돼 있으면 제외 (C)
        if(OTHER_SIGUN.some(s => orgText.includes(s) || sgg.includes(s))) return false;

        // 위 어디에도 해당 없음 → 광역 혜택으로 간주 통과 (A)
        return true;
      });
    }

    // ── 3단계: 제외 키워드 필터 ──
    filtered = filtered.filter(p => {
      const text = p.title + ' ' + p.benefit_summary;
      return !EXCLUDE_KEYWORDS.some(kw => text.includes(kw));
    });

    // ── 4단계: match_score 내림차순 정렬 ──
    filtered.sort((a, b) => b.match_score - a.match_score);

    // 임시 필드 제거
    const policies = filtered.slice(0, parseInt(size)).map(({ ctpvNm, sggNm, ...rest }) => rest);

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

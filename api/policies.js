/**
 * 단단 — 복지로 지자체복지서비스 API 프록시
 * GET /api/policies?city=서울&district=마포구
 * Vercel 환경변수: BOKJIRO_API_KEY
 */

const SIDO_CODE = {
  '서울':'11','경기':'41','인천':'28','부산':'26',
};

const SIGUNGU_CODE = {
  // 서울
  '강남구':'11680','강동구':'11740','강북구':'11305','강서구':'11500',
  '관악구':'11620','광진구':'11215','구로구':'11530','금천구':'11545',
  '노원구':'11350','도봉구':'11320','동대문구':'11230','동작구':'11590',
  '마포구':'11440','서대문구':'11410','서초구':'11650','성동구':'11200',
  '성북구':'11290','송파구':'11710','양천구':'11470','영등포구':'11560',
  '용산구':'11170','은평구':'11380','종로구':'11110','중구':'11140','중랑구':'11260',
  // 경기 성남
  '성남시 분당구':'41135','성남시 수정구':'41111','성남시 중원구':'41113',
  // 경기 수원
  '수원시 권선구':'41113','수원시 영통구':'41117','수원시 장안구':'41111','수원시 팔달구':'41115',
  // 인천
  '계양구':'28245','미추홀구':'28177','남동구':'28200','동구':'28140',
  '부평구':'28237','서구':'28260','연수구':'28185','중구':'28110',
  // 부산
  '강서구':'26440','금정구':'26410','남구':'26290','동구':'26170',
  '동래구':'26260','부산진구':'26230','북구':'26330','사상구':'26530',
  '사하구':'26380','서구':'26140','수영구':'26500','연제구':'26470',
  '영도구':'26200','중구':'26110','해운대구':'26350',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if(req.method === 'OPTIONS'){ res.status(200).end(); return; }

  const { city, district, life, theme, page = '1', size = '20' } = req.query;
  const apiKey = process.env.BOKJIRO_API_KEY;

  if(!apiKey) return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });
  if(!city)   return res.status(400).json({ error: 'city 파라미터가 필요합니다.' });

  const sidoCd    = SIDO_CODE[city];
  const sigunguCd = district ? SIGUNGU_CODE[district] : undefined;
  if(!sidoCd) return res.status(400).json({ error: `지원하지 않는 지역: ${city}` });

  const params = new URLSearchParams({
    serviceKey: apiKey,
    callTp:    'L',
    pageNo:    page,
    numOfRows: size,
    siDoCd:    sidoCd,
  });
  if(sigunguCd) params.append('siGunGuCd',      sigunguCd);
  if(life)      params.append('lifeArray',       life);
  if(theme)     params.append('intrsThemaArray', theme);

  const url = `http://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations/LcgvWelfarelist?${params}`;

  try {
    // ── XML 응답 받기 ──
    const upstream = await fetch(url);
    if(!upstream.ok) throw new Error(`복지로 HTTP ${upstream.status}`);
    const xml = await upstream.text();

    // ── XML → JS 객체 파싱 (정규식 기반, 외부 라이브러리 없이) ──
    const total = parseInt(getXmlVal(xml, 'totalCount') || '0');

    // <servList>...</servList> 블록 전체 추출
    const blocks = [];
    const re = /<servList>([\s\S]*?)<\/servList>/g;
    let m;
    while((m = re.exec(xml)) !== null) blocks.push(m[1]);

    const policies = blocks.map(block => {
      const get = tag => getXmlVal(block, tag) || '';
      return {
        id:              get('servId'),
        title:           get('servNm'),
        org:             get('bizChrDeptNm') || get('ctpvNm'),
        org_type:        'local_gov',
        source_portal:   get('servDtlLink'),
        region_city:     city,
        region_district: district || get('sggNm') || null,
        category:        mapThemeNm(get('intrsThemaNmArray')),
        benefit_summary: cleanText(get('servDgst')) || get('servNm'),
        benefit_detail:  cleanText(get('servDgst')),
        conditions_plain: parseConditions(get('alwServCn') || get('servDgst')),
        apply_method:    get('aplyMtdNm') || '-',
        apply_url:       get('servDtlLink') || null,
        apply_end:       get('rcvPeriodCn') || null,
        is_recurring:    !get('rcvPeriodCn'),
        match_score:     85,
        target_summary:  get('lifeNmArray') || get('tgterIndvdlNmArray') || '',
        tags:            [],
      };
    });

    return res.status(200).json({
      success: true, total,
      page: parseInt(page), size: parseInt(size),
      city, district: district || null,
      policies,
    });

  } catch(e) {
    console.error('복지로 API 실패:', e.message);
    return res.status(502).json({ error: '복지로 API 호출 실패', message: e.message });
  }
}

/* ── 헬퍼 ── */

// XML 태그값 추출
function getXmlVal(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
  return m ? m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim() : null;
}

// 텍스트 정리 (특수문자·이모지 제거, 공백 정리)
function cleanText(text) {
  if(!text) return '';
  return text.replace(/❍|◆|●|▶|•/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// 관심주제명 → 단단 카테고리
function mapThemeNm(nm) {
  if(!nm) return '생활·문화';
  if(nm.includes('주거'))            return '주거';
  if(nm.includes('일자리'))          return '취업';
  if(nm.includes('건강'))            return '건강';
  if(nm.includes('금융') || nm.includes('서민금융') || nm.includes('법률')) return '금융';
  if(nm.includes('교육') || nm.includes('보육'))  return '교육';
  return '생활·문화';
}

// 자격조건 텍스트 → 배열
function parseConditions(text) {
  if(!text) return [];
  return text
    .split(/[\n❍◆●▶•\-○◦]+/)
    .map(s => s.trim())
    .filter(s => s.length > 4)
    .slice(0, 4);
}

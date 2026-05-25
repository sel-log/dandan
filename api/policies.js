/**
 * 단단 — 복지로 지자체복지서비스 API 프록시
 * GET /api/policies?city=서울&district=마포구&life=004&theme=040
 *
 * Vercel 환경변수: BOKJIRO_API_KEY
 */

// 시도코드 매핑 (복지로 API 기준)
const SIDO_CODE = {
  '서울': '11', '경기': '41', '인천': '28', '부산': '26',
};

// 시군구코드 매핑 (주요 구만 포함 — 필요 시 확장)
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
  // CORS 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if(req.method === 'OPTIONS'){ res.status(200).end(); return; }

  const { city, district, life, theme, page = '1', size = '20' } = req.query;
  const apiKey = process.env.BOKJIRO_API_KEY;

  if(!apiKey){
    return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });
  }
  if(!city){
    return res.status(400).json({ error: 'city 파라미터가 필요합니다.' });
  }

  const sidoCd    = SIDO_CODE[city];
  const sigunguCd = district ? SIGUNGU_CODE[district] : undefined;

  if(!sidoCd){
    return res.status(400).json({ error: `지원하지 않는 지역입니다: ${city}` });
  }

  // 복지로 API 파라미터 조립
  const params = new URLSearchParams({
    serviceKey: apiKey,
    callTp:     'L',          // 목록 조회
    pageNo:     page,
    numOfRows:  size,
    siDoCd:     sidoCd,
  });

  if(sigunguCd)         params.append('siGunGuCd',       sigunguCd);
  if(life)              params.append('lifeArray',        life);   // 생애주기 코드
  if(theme)             params.append('intrsThemaArray',  theme);  // 관심주제 코드

  const url = `http://apis.data.go.kr/B554287/LocalGovernmentWelfareInformations/LcgvWelfarelist?${params}`;

  try {
    const upstream = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if(!upstream.ok){
      throw new Error(`복지로 API 오류: ${upstream.status}`);
    }

    const raw = await upstream.json();

    // 복지로 응답 → 단단 포맷 변환
    const items = raw?.body?.items?.item ?? [];
    const total = raw?.body?.totalCount ?? 0;

    const policies = (Array.isArray(items) ? items : [items]).map(item => ({
      id:              item.servId,
      title:           item.servNm,
      org:             item.intrsThemaArray || item.jurOrgNm || '',
      org_type:        'local_gov',
      source_portal:   item.servDtlLink || null,
      region_city:     city,
      region_district: district || null,
      category:        mapTheme(item.intrsThemaArray),
      benefit_summary: item.servSumry || item.servNm,
      benefit_detail:  item.servDtlCn || '',
      conditions_plain: parseConditions(item.alwServCn || ''),
      apply_method:    item.aplyMtdCd || 'both',
      apply_url:       item.servDtlLink || null,
      apply_end:       item.rcvPeriodCn || null,
      is_recurring:    !item.rcvPeriodCn,
      match_score:     85,
      target_summary:  item.tgterIndvdlArray || '',
      tags:            [],
    }));

    return res.status(200).json({
      success: true,
      total,
      page:    parseInt(page),
      size:    parseInt(size),
      city,
      district: district || null,
      policies,
    });

  } catch(e) {
    console.error('복지로 API 호출 실패:', e.message);
    return res.status(502).json({
      error:   '복지로 API 호출에 실패했습니다.',
      message: e.message,
    });
  }
}

/* ── 헬퍼 ── */

// 관심주제 코드 → 단단 카테고리
function mapTheme(code){
  const map = {
    '010':'건강','020':'건강','030':'생활·문화',
    '040':'주거','050':'취업','060':'생활·문화',
    '070':'생활·문화','130':'금융','140':'금융',
  };
  const first = String(code || '').slice(0,3);
  return map[first] || '생활·문화';
}

// 자격조건 텍스트 → 배열로 분리
function parseConditions(text){
  if(!text) return [];
  return text
    .split(/[\n•·\-○◦]+/)
    .map(s => s.trim())
    .filter(s => s.length > 2)
    .slice(0, 5);
}

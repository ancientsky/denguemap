// Fixtures built from the verbatim samples recorded in the endpoint report
// (cdcdengue.azurewebsites.net, 2026-10-16).

export const LOCATION_RECORDS = [
  { sickdate: '2026/09/26', lat: '24.076008586', lng: '120.546402727', count: 1 },
  { sickdate: '2026/10/14', lat: '22.61', lng: '120.30', count: 2 },
  { sickdate: '2026/01/05', lat: '25.0330', lng: '121.5654', count: '1' },
];

export const IMPORTED_RECORDS = [
  { sickdate: '2023/01/01', lat: '23.9740931', lng: '120.9799029', country_name: '菲律賓', count: 1, country_code: 'ph', country_lat: 12.879721, country_lng: 121.774017 },
  { sickdate: '2026/09/20', lat: '22.6', lng: '120.3', country_name: '越南', count: 2, country_code: 'vn', country_lat: 14.058324, country_lng: 108.277199 },
  { sickdate: '2026/03/02', lat: '22.6', lng: '120.3', country_name: '越南', count: 1, country_code: 'vn', country_lat: 14.058324, country_lng: 108.277199 },
  { sickdate: '2024/05/02', lat: '22.6', lng: '120.3', country_name: '印尼', count: 1, country_code: 'id', country_lat: -0.789275, country_lng: 113.921327 },
];

export const NOTICE_RECORDS = [
  {
    effective: '2026-09-29T08:25:50+08:00',
    headline: '越南-登⾰熱',
    description: '越南胡志明市今年截⾄第38週(9/20)累計報告34,161例病例，<b>較去年</b>同期增加。<script>alert(1)</script>',
    web: 'https://www.cdc.gov.tw/TravelEpidemic/Detail/G3PSay_dafdAwjsYNm3CCA?epidemicId=DAqX4O2HjsfzJesbSDg7Jw',
  },
];

export const CLUSTER_FEATURE = {
  type: 'Feature',
  properties: { CODE1: 'A6801-57-009', TOWN: '桃園區', sick_date: '20200721', ttl_determined_cnt: 2.0, extra: 'drop me' },
  geometry: {
    type: 'Polygon',
    coordinates: [[[121.302682570961, 25.0033885897636], [121.30468, 25.0033885897636], [121.30468, 25.00539], [121.302682570961, 25.00539], [121.302682570961, 25.0033885897636]]],
  },
};

export const VECTOR_RED = {
  type: 'Feature',
  properties: {
    COUNTY: '屏東縣', TOWN: '屏東市', VILLAGE: '大同里',
    weeks: [
      { dS: '10/4/2026', dE: '10/10/2026', m_level: null, b_pos: 60, g_pos: null, color: 'red' },
      { dS: '9/27/2026', dE: '10/3/2026', m_level: null, b_pos: null, g_pos: null, color: 'gray' },
      { dS: '9/20/2026', dE: '9/26/2026', m_level: 2, b_pos: 30, g_pos: 12.5, color: 'orange' },
      { dS: '9/13/2026', dE: '9/19/2026', m_level: null, b_pos: null, g_pos: null, color: 'gray' },
      { dS: '9/6/2026', dE: '9/12/2026', m_level: null, b_pos: 10, g_pos: null, color: 'yellow' },
    ],
    bucket_positive_rate: 60, bucket_total_eggs: 120, bucket_color: 'red', background_color: 'red',
  },
  geometry: { type: 'Point', coordinates: [120.48787510958061, 22.66994435786596] },
};

export const GRAY_WEEKS = [
  { dS: '10/4/2026', dE: '10/10/2026', m_level: null, b_pos: null, g_pos: null, color: 'gray' },
  { dS: '9/27/2026', dE: '10/3/2026', m_level: null, b_pos: null, g_pos: null, color: 'gray' },
  { dS: '9/20/2026', dE: '9/26/2026', m_level: null, b_pos: null, g_pos: null, color: 'gray' },
  { dS: '9/13/2026', dE: '9/19/2026', m_level: null, b_pos: null, g_pos: null, color: 'gray' },
  { dS: '9/6/2026', dE: '9/12/2026', m_level: null, b_pos: null, g_pos: null, color: 'gray' },
];

export const VECTOR_GRAY = {
  type: 'Feature',
  properties: { COUNTY: '臺北市', TOWN: '大安區', VILLAGE: '仁愛里', weeks: GRAY_WEEKS, background_color: 'gray' },
  geometry: { type: 'Point', coordinates: [121.54, 25.03] },
};

export const NS1_PROPS = {
  city: '臺北市', hospName: '長庚紀念醫院', hospID: '1101010012', hospAddress: '臺北市松山區敦化北路199號',
  latitude: '25.055508', longitude: '121.549618', hospTel: '02-27135211', code: '01',
};

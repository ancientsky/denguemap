// @ts-check
/** Pipeline constants. */

export const DEFAULT_BASE_URL = 'https://cdcdengue.azurewebsites.net/';

/** Per-request timeout and response cap. */
export const REQUEST_TIMEOUT_MS = 90_000;
export const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
export const MAX_ATTEMPTS = 4;
export const BACKOFF_BASE_MS = 1500;
export const CONCURRENCY = 4;

/** Case data starts here. */
export const FIRST_YEAR = 1998;

/** Taiwan incl. Kinmen / Matsu / Penghu. */
export const BBOX = { minLng: 118.1, maxLng: 122.1, minLat: 21.8, maxLat: 26.4 };

/** Nearest-town fallback for coastal points (metres). */
export const NEAREST_TOWN_MAX_M = 3000;

/** CDC city code -> MOI county code (same as taiwan-atlas COUNTYCODE). */
export const CDC_TO_MOI = Object.freeze({
  '01': '63000', // 臺北市
  '31': '65000', // 新北市
  '32': '68000', // 桃園市
  '03': '66000', // 臺中市
  '05': '67000', // 臺南市
  '07': '64000', // 高雄市
  '11': '10017', // 基隆市
  '12': '10018', // 新竹市
  '33': '10004', // 新竹縣
  '34': '10002', // 宜蘭縣
  '35': '10005', // 苗栗縣
  '37': '10007', // 彰化縣
  '38': '10008', // 南投縣
  '39': '10009', // 雲林縣
  '22': '10020', // 嘉義市
  '40': '10010', // 嘉義縣
  '43': '10013', // 屏東縣
  '44': '10016', // 澎湖縣
  '45': '10015', // 花蓮縣
  '46': '10014', // 臺東縣
  '90': '09020', // 金門縣
  '91': '09007', // 連江縣
});

/** CDC city codes that can have cluster polygons. */
export const CLUSTER_CITY_CODES = Object.freeze([
  '01', '03', '05', '07', '11', '12', '22', '31', '32', '33', '35', '37', '38', '39', '40', '43',
]);

export const NS1_PATH = 'data/ns1/ns1hosp_20160603_lzstring.json';
export const VECTOR_PATH = 'data/geojson/cdcdengueVillagePoint.json';

/**
 * Reference counts per year (records, local / imported) observed 2026-10-16.
 * Used only as a floor when there is no previously committed file.
 */
export const REFERENCE_COUNTS = Object.freeze({
  local: [305, 42, 113, 226, 5311, 86, 335, 202, 964, 1997, 486, 847, 1591, 1476, 1263, 595, 15481, 43181, 381, 9, 183, 100, 73, 0, 20, 24794, 232, 29, 14],
  imported: [30, 26, 21, 52, 48, 51, 77, 86, 90, 167, 198, 170, 266, 136, 183, 218, 218, 332, 318, 298, 350, 539, 64, 10, 68, 271, 198, 226, 185],
});

/**
 * Fixed historical reference for imported.json (GetImportedData), 2023-01-01..2026-10-14.
 * Never update this to newer (lower) numbers: it exists to tell the UI about upstream shortfalls.
 */
export const IMPORTED_REFERENCE = Object.freeze({
  total: 894,
  byYear: Object.freeze({ 2023: 271, 2024: 203, 2025: 229, 2026: 191 }),
});

/** A count below this fraction of its reference raises a manifest warning. */
export const WARN_RATIO = 0.8;

/** Max allowed relative shrink of a year's count vs previous / reference. */
export const SHRINK_TOLERANCE = { rel: 0.02, abs: 5 };

/** Names of the independent sources, in manifest order. */
export const SOURCE_NAMES = /** @type {const} */ (['cases', 'imported', 'notices', 'clusters', 'vector', 'ns1']);

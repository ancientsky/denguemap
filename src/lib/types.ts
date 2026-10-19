// Types mirroring docs/data-contract.md (after validation/normalisation).

export interface SourceStatus {
  ok: boolean;
  stale: boolean;
  fetchedAt: string | null;
  records: number | null;
  periodStart?: string;
  periodEnd?: string;
  sourceDate?: string;
  /** travel: SafeTravel generated_at */
  updated?: string;
  /** cases/imported: years whose data was kept from an earlier run because upstream returned less (contract v3). */
  keptYears?: number[];
  /** cases/imported: last successful fetch per year (ISO), keyed by 'YYYY'. */
  yearsFetchedAt?: Record<string, string>;
}

/** Data-quality warning from the pipeline, e.g. upstream lost most records of a year. */
export interface DataWarning {
  code: string; // 'cases-shortfall' | 'imported-shortfall' | future codes
  year: number | null;
  type: 'local' | 'imported' | null;
  got: number;
  expected: number;
}

export interface Manifest {
  schema: number;
  generatedAt: string;
  latestOnset: string;
  years: number[];
  sources: Record<string, SourceStatus>;
  warnings: DataWarning[];
  files: Record<string, string>;
  /** true only for synthetic fixtures (scripts/fixtures) — the UI then shows a prominent banner. */
  fixture: boolean;
}

export interface LI {
  local: number;
  imported: number;
}

export interface Summary {
  asOf: string;
  latestOnset: string;
  year: number;
  ytd: LI;
  last7: LI;
  last14: LI;
  last30: LI;
  prevYtd: LI;
  byCounty: Record<string, LI>;
  topTowns14: [string, number, number][];
}

/** [lng, lat, townCode|null] */
export type CasePoint = [number, number, string | null];
/** [dayOfYear, ptIndex, imported(0|1), count] */
export type CaseRow = [number, number, 0 | 1, number];

export interface CasesYear {
  year: number;
  pts: CasePoint[];
  c: CaseRow[];
}

export interface Trend {
  start: string;
  end: string;
  national: { local: number[]; imported: number[] };
  county: Record<string, { local: [number, number][]; imported: [number, number][] }>;
}

export interface ImportedCountry {
  zh: string;
  lat: number;
  lng: number;
  byYear: Record<string, number>;
  byMonth: Record<string, number>;
}
/** [dayIndex from `from` (0-based), iso2, cases that day] */
export type ImportedEvent = [number, string, number];
export interface Imported {
  from: string;
  to: string;
  countries: Record<string, ImportedCountry>;
  /** v2; null when the file predates it (the UI then derives approximate events from byMonth). */
  events: ImportedEvent[] | null;
}

// ---------------------------------------------------------------- travel.json (v2)
export const VB_KEYS = ['dengue', 'chikungunya', 'zika', 'yellowFever', 'malaria', 'japaneseEncephalitis', 'westNile'] as const;
export type VbKey = (typeof VB_KEYS)[number];
export interface TravelLevel {
  zh: string;
  en: string;
  adviceZh: string;
  adviceEn: string;
}
export interface TravelAdvisory {
  d: VbKey;
  level: 1 | 2 | 3;
  since: string;
  areaZh: string;
  areaEn: string;
}
export interface TravelCountry {
  zh: string;
  en: string;
  level: 0 | 1 | 2 | 3;
  vb: TravelAdvisory[];
}
export interface TravelNews {
  id: string;
  date: string;
  d: VbKey[];
  countries: string[];
  headlineZh: string;
  headlineEn: string;
  summaryZh: string;
  summaryEn: string;
  url: string | null;
}
export interface Travel {
  updated: string;
  levels: Record<'1' | '2' | '3', TravelLevel>;
  diseases: Record<VbKey, { zh: string; en: string }>;
  countries: Record<string, TravelCountry>;
  news: TravelNews[];
}

export interface Notice {
  date: string;
  headline: string;
  text: string;
  url: string | null;
}
export type Notices = Record<string, Notice[]>;

/** [color, breteauLevel|null, ovitrap%|null, gravitrap%|null] */
export type VectorWeek = [0 | 1 | 2 | 3, number | null, number | null, number | null];
/** [county, town, village, lng, lat, villCode|null, overall, weeks] */
export type VectorVillage = [string, string, string, number, number, string | null, 0 | 1 | 2 | 3, VectorWeek[]];
export interface Vector {
  updated: string;
  weeks: [string, string][];
  villages: VectorVillage[];
  surveyed: Record<string, { villages: number; total: number }>;
}

export interface ClusterProps {
  county: string;
  town: string;
  /** Village (里) of the cluster's first-level dissemination area; '' when upstream gives none. */
  village: string;
  code1: string;
  count: number;
  lastOnset: string;
}
export interface Clusters {
  type: 'FeatureCollection';
  fetchedAt: string | null;
  features: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, ClusterProps>[];
}

/** [name, address, tel, lng, lat, hospID, countyCode] */
export type Hospital = [string, string, string, number, number, string, string];
export interface NS1 {
  sourceDate: string;
  h: Hospital[];
}

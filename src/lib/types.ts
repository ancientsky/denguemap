// Types mirroring docs/data-contract.md (after validation/normalisation).

export interface SourceStatus {
  ok: boolean;
  stale: boolean;
  fetchedAt: string | null;
  records: number | null;
  periodStart?: string;
  periodEnd?: string;
  sourceDate?: string;
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
export interface Imported {
  from: string;
  to: string;
  countries: Record<string, ImportedCountry>;
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

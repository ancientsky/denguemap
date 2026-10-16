// Data-quality helpers over manifest.warnings and manifest.sources (pure; unit-tested).
import type { DataWarning, Manifest, SourceStatus } from './types';

/** cases-shortfall warnings for a year (optionally only those relevant to a case-type filter). */
export function casesShortfalls(warnings: readonly DataWarning[], year: number, type: 'local' | 'imported' | 'all' = 'all'): DataWarning[] {
  return warnings.filter((w) => w.code === 'cases-shortfall' && w.year === year && (type === 'all' || w.type === null || w.type === type));
}

/** Years having any cases-shortfall warning. */
export function shortfallYears(warnings: readonly DataWarning[], type: 'local' | 'imported' | 'all' = 'all'): Set<number> {
  const s = new Set<number>();
  for (const w of warnings) if (w.code === 'cases-shortfall' && w.year != null && (type === 'all' || w.type === null || w.type === type)) s.add(w.year);
  return s;
}

/** imported-shortfall for one year, or the all-period (year-less) entry when year is null. */
export function importedShortfall(warnings: readonly DataWarning[], year: number | null): DataWarning | null {
  return warnings.find((w) => w.code === 'imported-shortfall' && w.year === year) ?? null;
}

export type SourceState = 'fresh' | 'stale' | 'unavailable';
/** ok:true → fresh; stale:true → latest fetch failed, previous data shown; ok:false & !stale → never fetched. */
export function sourceState(s: SourceStatus | undefined): SourceState {
  if (!s) return 'unavailable';
  if (s.ok && !s.stale) return 'fresh';
  if (s.stale) return 'stale';
  return 'unavailable';
}

export function isUnavailable(m: Manifest | null, key: string): boolean {
  return !!m && key in m.sources && sourceState(m.sources[key]) === 'unavailable';
}

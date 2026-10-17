// Pure helpers for travel advisories, news and imported-case events (unit-tested).
import { dayDiff, parseISO, toISO } from './dates';
import type { Imported, ImportedEvent, Travel, TravelCountry, TravelNews, VbKey } from './types';

export type AdvisoryMode = 'vb' | 'all';

/** Highest mosquito-borne advisory level for a country (0 = none). */
export function vbLevel(c: TravelCountry | undefined): 0 | 1 | 2 | 3 {
  let m = 0;
  for (const a of c?.vb ?? []) if (a.level > m) m = a.level;
  return m as 0 | 1 | 2 | 3;
}

export function advisoryLevel(c: TravelCountry | undefined, mode: AdvisoryMode): 0 | 1 | 2 | 3 {
  return mode === 'vb' ? vbLevel(c) : (c?.level ?? 0);
}

/** iso2 → level for every country in travel.json. */
export function levelsByCountry(t: Travel, mode: AdvisoryMode): Map<string, 0 | 1 | 2 | 3> {
  const out = new Map<string, 0 | 1 | 2 | 3>();
  for (const [cc, c] of Object.entries(t.countries)) out.set(cc, advisoryLevel(c, mode));
  return out;
}

/** Count countries per level (index 0..3). */
export function levelHistogram(levels: Map<string, number>): [number, number, number, number] {
  const h: [number, number, number, number] = [0, 0, 0, 0];
  for (const l of levels.values()) if (l >= 0 && l <= 3) h[l as 0 | 1 | 2 | 3]++;
  return h;
}

export interface NewsFilter {
  diseases?: ReadonlySet<VbKey> | null; // null/empty = all
  country?: string | null;
}
export function filterNews(news: readonly TravelNews[], f: NewsFilter): TravelNews[] {
  const ds = f.diseases && f.diseases.size ? f.diseases : null;
  return news.filter((n) => (!ds || n.d.some((d) => ds.has(d))) && (!f.country || n.countries.includes(f.country)));
}

/**
 * Imported-case events per day. Uses imported.json `events` (v2); for older files without them,
 * spreads each country's monthly counts evenly over the month (deterministic, approximate).
 */
export function importedEvents(imp: Imported): { events: ImportedEvent[]; approximate: boolean } {
  if (imp.events) return { events: imp.events, approximate: false };
  const t0 = parseISO(imp.from);
  const span = dayDiff(imp.from, imp.to);
  const out: ImportedEvent[] = [];
  for (const [cc, c] of Object.entries(imp.countries)) {
    for (const [ym, n] of Object.entries(c.byMonth)) {
      const first = Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1);
      const days = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
      for (let i = 0; i < n; i++) {
        const di = Math.round((first - t0) / 86_400_000) + Math.min(days - 1, Math.floor(((i + 0.5) * days) / n));
        if (di >= 0 && di <= span) out.push([di, cc, 1]);
      }
    }
  }
  out.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return { events: out, approximate: true };
}

/** Index range [lo, hi) of events whose dayIndex falls in [a, b]. Events must be sorted. */
export function eventRange(events: readonly ImportedEvent[], a: number, b: number): [number, number] {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (events[m]![0] < a) lo = m + 1;
    else hi = m;
  }
  let end = lo;
  while (end < events.length && events[end]![0] <= b) end++;
  return [lo, end];
}

export const dayToISO = (from: string, di: number): string => toISO(parseISO(from) + di * 86_400_000);

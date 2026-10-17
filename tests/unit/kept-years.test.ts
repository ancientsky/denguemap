import { describe, expect, it } from 'vitest';
import { validateManifest } from '../../src/lib/validate';
import { keptYears, sourceState } from '../../src/lib/warnings';

const base = {
  schema: 1, generatedAt: '2026-10-17T10:00:00Z', latestOnset: '2026-10-14', years: [2023, 2024, 2025, 2026], warnings: [], files: {},
};

describe('manifest keptYears (contract v3)', () => {
  const m = validateManifest({
    ...base,
    sources: {
      cases: { ok: true, stale: false, fetchedAt: '2026-10-17T10:00:00Z', records: 1, keptYears: [2025, 'x', 1800, 2025], yearsFetchedAt: { 2025: '2026-10-16T23:39:12Z', bad: 'x', 2026: 'nope' } },
      imported: { ok: true, stale: false, fetchedAt: '2026-10-17T10:00:00Z', records: 1, keptYears: [2023, 2024, 2025] },
    },
  });
  it('keeps only valid years and timestamps', () => {
    expect(m.sources.cases!.keptYears).toEqual([2025]);
    expect(m.sources.cases!.yearsFetchedAt).toEqual({ 2025: '2026-10-16T23:39:12Z' });
  });
  it('a kept past year does not make the source stale', () => {
    expect(sourceState(m.sources.cases)).toBe('fresh');
  });
  it('lists kept years, optionally filtered to the years in view', () => {
    expect(keptYears(m, 'cases')).toEqual([{ year: 2025, at: '2026-10-16T23:39:12Z' }]);
    expect(keptYears(m, 'cases', [2026])).toEqual([]);
    expect(keptYears(m, 'imported', [2024, 2026])).toEqual([{ year: 2024, at: null }]);
    expect(keptYears(null, 'cases')).toEqual([]);
  });
});

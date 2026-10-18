// Model parameters. The literature-based assumptions are fixed here; the "tuned" values come from
// the backtest (tests/backtest/backtest.run.mjs: chosen on 2002, 2014 and 2015, checked on 2023) and live in tuned.json.
import type { ForecastParams } from './model';
import tuned from './tuned.json';

export const BASE_PARAMS: ForecastParams = {
  // Dengue onset-to-onset interval: intrinsic incubation + viraemia + extrinsic incubation in the mosquito,
  // about 2–3 weeks.
  gi: { mean: 16, sd: 5, max: 40 },
  // ASSUMPTION (no report dates in the source): onset → care → NS1/PCR confirmation → publication.
  delay: { mean: 6, sd: 4, max: 28 },
  rtWindow: 14,
  prior: { shape: 1, scale: 5 },
  dispersion: 0.5,
  damping: 0.8,
  rwSd: 0.1,
  importedWeight: 0.5,
  horizon: 28,
  sims: 1000,
  minCases: 10,
  seed: 20150801,
};

export type TunedParams = Pick<ForecastParams, 'dispersion' | 'damping' | 'rwSd' | 'importedWeight' | 'prior'>;

export const PARAMS: ForecastParams = { ...BASE_PARAMS, ...(tuned as Partial<TunedParams>) };

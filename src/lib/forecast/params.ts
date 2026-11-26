// Model parameters. The literature-based assumptions are fixed here; the "tuned" values come from
// the backtest (tests/backtest/backtest.run.mjs: chosen on 2002, 2014 and 2015, checked on 2023) and live in tuned.json.
import type { ForecastParams } from './model';
import { DEFAULT_SURFACE, type SurfaceParams } from './surface';
import surfaceTuned from './surface-tuned.json';
import tuned from './tuned.json';

export const BASE_PARAMS: ForecastParams = {
  // Dengue onset-to-onset interval: intrinsic incubation + viraemia + extrinsic incubation in the mosquito,
  // about 2–3 weeks.
  gi: { mean: 16, sd: 5, max: 40 },
  // Onset → confirmation (when a case appears in the data). Measured in the Taiwan CDC open data (2010+): about
  // 6 days in quiet years and early in an outbreak, 2–4 days at an outbreak's peak (tests/backtest/delay.json).
  // The backtest picks the model's value among candidates (tuned.json); this is the fallback.
  delay: { mean: 6, sd: 4, max: 28 },
  rtWindow: 14,
  prior: { shape: 1, scale: 5 },
  dispersion: 0.5,
  damping: 0.8,
  rwSd: 0.1,
  importedWeight: 0.5,
  tempGamma: 0,
  horizon: 28,
  sims: 1000,
  minCases: 10,
  seed: 20150801,
};

export type TunedParams = Pick<ForecastParams, 'dispersion' | 'damping' | 'rwSd' | 'importedWeight' | 'prior' | 'tempGamma' | 'delay'>;

export const PARAMS: ForecastParams = { ...BASE_PARAMS, ...(tuned as Partial<TunedParams>) };

/** Risk-surface kernel (tests/backtest/spatial.run.mjs: tuned on 2002, 2014 and 2015, checked on 2023). */
export const SURFACE: SurfaceParams = { ...DEFAULT_SURFACE, ...(surfaceTuned as Partial<SurfaceParams>) };

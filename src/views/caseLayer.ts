// Shared case-point layer: features with recency/type properties, circle paint for both colour modes,
// and popup content. Used by the map view and by the vector view's "recent cases" overlay.
import type { CircleLayerSpecification, ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec';
import { fmtDate, fmtNum, t } from '../i18n';
import { recencyBucket, type CaseAggregate } from '../lib/aggregate';
import { dateFromDoy, dayDiff } from '../lib/dates';
import { h } from '../lib/dom';
import type { CasesYear } from '../lib/types';
import type { Palette } from '../map/palette';

export type ColorMode = 'recency' | 'type';

/**
 * One feature per statistical-area centroid. Properties:
 *  l/i: local/imported counts, n: total, a: days from the latest onset to refISO,
 *  r: recency bucket (0 ≤7d … 3 >30d), k: 0 local only, 1 imported only, 2 both.
 */
export function caseFeatures(file: CasesYear, agg: CaseAggregate, refISO: string, idBase = 0): GeoJSON.Feature<GeoJSON.Point>[] {
  const out: GeoJSON.Feature<GeoJSON.Point>[] = [];
  for (const [idx, [l, i]] of agg.byPt) {
    const p = file.pts[idx]!;
    const last = agg.lastDay.get(idx) ?? 1;
    const a = Math.max(0, dayDiff(dateFromDoy(file.year, last), refISO));
    out.push({
      type: 'Feature', id: idBase + idx,
      properties: { l, i, n: l + i, a, r: recencyBucket(a), k: l > 0 && i > 0 ? 2 : i > 0 ? 1 : 0, y: file.year, d: last },
      geometry: { type: 'Point', coordinates: [p[0], p[1]] },
    });
  }
  return out;
}

const radius: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 6, ['+', 2.6, ['*', 1.5, ['sqrt', ['get', 'n']]]], 12, ['+', 5.5, ['*', 3.2, ['sqrt', ['get', 'n']]]]];

/** Paint for the case circles. Recency mode: colour by age; imported-only points are thick rings. */
export function casePaint(p: Palette, mode: ColorMode): NonNullable<CircleLayerSpecification['paint']> {
  if (mode === 'type') {
    return {
      'circle-radius': radius,
      'circle-color': ['case', ['>=', ['get', 'l'], ['get', 'i']], p.local, p.imported],
      'circle-opacity': 0.85,
      'circle-stroke-color': p.halo,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 0.7, 12, 1.4],
      'circle-stroke-opacity': 0.95,
    };
  }
  const rec: ExpressionSpecification = ['match', ['get', 'r'], 0, p.rec[0], 1, p.rec[1], 2, p.rec[2], p.rec[3]];
  const ring: ExpressionSpecification = ['==', ['get', 'k'], 1];
  return {
    'circle-radius': radius,
    'circle-color': ['case', ring, 'rgba(0,0,0,0)', rec],
    'circle-opacity': ['case', ['==', ['get', 'r'], 3], 0.7, 0.92],
    'circle-stroke-color': ['case', ring, rec, p.recStroke],
    // zoom expressions must be the top-level interpolate
    'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, ['case', ring, 2.4, 0.8], 12, ['case', ring, 3.6, 1.4]],
    'circle-stroke-opacity': ['case', ['==', ['get', 'r'], 3], 0.75, 1],
  };
}

/** Recent cases drawn on top; within a bucket, small circles above big ones. */
export function caseSortKey(mode: ColorMode): ExpressionSpecification {
  return mode === 'recency'
    ? ['-', 0, ['+', ['*', ['get', 'r'], 100000], ['get', 'n']]]
    : ['-', 0, ['get', 'n']];
}

export interface CasePopupOpts {
  title: string;
  showLocal: boolean;
  showImported: boolean;
  rangeText: string | null;
  props: Record<string, unknown>;
}
export function casePopup(o: CasePopupOpts): HTMLElement {
  const pr = o.props;
  const l = Number(pr.l) || 0, i = Number(pr.i) || 0, a = Number(pr.a) || 0, y = Number(pr.y), d = Number(pr.d);
  const last = Number.isFinite(y) && Number.isFinite(d) ? dateFromDoy(y, d) : '';
  return h('div', { class: 'pop' },
    h('p', { class: 'pop-title' }, o.title),
    h('p', { class: 'pop-sub' }, t('map.popupPoint')),
    h('dl', { class: 'pop-dl' },
      h('dt', null, t('map.popupCases')),
      h('dd', null, o.showLocal ? h('span', { class: 'pill local' }, `${t('common.local')} ${fmtNum(l)}`) : null,
        o.showImported ? h('span', { class: 'pill imported' }, `${t('common.importedShort')} ${fmtNum(i)}`) : null),
      last ? h('dt', null, t('map.popupLast')) : null,
      last ? h('dd', null, h('span', { class: `rec-dot rec-${recencyBucket(a)}`, 'aria-hidden': 'true' }), `${fmtDate(last)}（${a <= 0 ? t('kpi.today') : t('kpi.daysAgo', { n: a })}）`) : null,
      o.rangeText ? h('dt', null, t('map.range')) : null,
      o.rangeText ? h('dd', null, o.rangeText) : null));
}

/** Legend rows for recency colouring (+ shape key when imported cases are shown). */
export function recencyLegend(showShapes: boolean): HTMLElement[] {
  const rows: HTMLElement[] = [0, 1, 2, 3].map((r) => h('li', { class: 'legend-item legend-wide' },
    h('span', { class: 'lg-dot', style: { '--sw': `var(--rec-${r})` }, 'aria-hidden': 'true' }), t(`rec.${r}` as 'rec.0')));
  if (showShapes) {
    rows.push(
      h('li', { class: 'legend-item' }, h('span', { class: 'lg-dot', style: { '--sw': 'var(--muted)' }, 'aria-hidden': 'true' }), t('rec.shapeLocal')),
      h('li', { class: 'legend-item' }, h('span', { class: 'lg-ring-case', 'aria-hidden': 'true' }), t('rec.shapeImported')),
    );
  }
  return rows;
}

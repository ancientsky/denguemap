// Shared view UI: floating panel / mobile bottom sheet, form controls, KPI cards, tables.
import { fmtDateTime, fmtNum, t } from '../i18n';
import type { DataWarning } from '../lib/types';
import type { KeptYear } from '../lib/warnings';
import { h, nextId } from '../lib/dom';
import { icon, type IconName } from '../lib/icons';
import type { PaddingFn } from '../map/host';

const MOBILE = '(max-width: 760px)';
export const isMobile = (): boolean => matchMedia(MOBILE).matches;

export interface Panel {
  el: HTMLElement;
  body: HTMLElement;
  head: HTMLElement;
  /** Map padding so fitBounds keeps content clear of the panel / sheet. */
  padding: PaddingFn;
}

/** Floating panel on desktop; a collapsible bottom sheet on mobile. */
export function panel(title: string, intro?: string, extraClass = ''): Panel {
  const titleId = nextId('ph');
  const bodyId = nextId('pb');
  const body = h('div', { class: 'panel-body', id: bodyId });
  const handle = h('button', { type: 'button', class: 'sheet-handle', 'aria-controls': bodyId, 'aria-expanded': 'false' },
    h('span', { class: 'grip', 'aria-hidden': 'true' }), icon('chevronUp', 'icon sheet-chevron'), h('span', { class: 'sr-only' }, t('common.expand')));
  const head = h('div', { class: 'panel-head' }, h('h1', { id: titleId, class: 'panel-title' }, title), intro ? h('p', { class: 'panel-intro' }, intro) : null);
  const el = h('section', { class: `panel ${extraClass}`, 'aria-labelledby': titleId, dataset: { state: 'collapsed' } }, handle, head, body);
  const setState = (open: boolean) => {
    el.dataset.state = open ? 'expanded' : 'collapsed';
    handle.setAttribute('aria-expanded', String(open));
    handle.querySelector('.sr-only')!.textContent = open ? t('common.collapse') : t('common.expand');
  };
  handle.addEventListener('click', () => setState(el.dataset.state !== 'expanded'));
  // Swipe on the handle area (mobile)
  let y0 = -1;
  handle.addEventListener('pointerdown', (e) => (y0 = e.clientY));
  handle.addEventListener('pointerup', (e) => {
    if (y0 < 0) return;
    const dy = e.clientY - y0;
    y0 = -1;
    if (Math.abs(dy) > 30) {
      e.preventDefault();
      setState(dy < 0);
    }
  });
  // Panel / stage sizes for padding() come from ResizeObservers instead of layout reads: fitBounds is usually
  // called right after a view has filled the panel, where a getBoundingClientRect() forced a full reflow.
  let size: { w: number; h: number } | null = null;
  watchStage();
  new ResizeObserver(([e]) => {
    if (e) size = boxSize(e);
  }).observe(el);
  const padding: PaddingFn = () => {
    const panelSize = size ?? { w: el.offsetWidth, h: el.offsetHeight }; // not observed yet (rare): measure once
    if (isMobile()) {
      // The sheet sits at the bottom of the stage (main): its height is how much of the map it covers.
      const h = stageHeight(el);
      const bottom = h ? Math.max(24, panelSize.h + 12) : 200;
      return { top: 24, right: 24, bottom: Math.min(bottom, (h || 600) * 0.6), left: 24 };
    }
    return { top: 88, right: 72, bottom: 56, left: panelSize.w + 56 };
  };
  return { el, body, head, padding };
}

function boxSize(e: ResizeObserverEntry): { w: number; h: number } {
  const b = e.borderBoxSize?.[0];
  return b ? { w: b.inlineSize, h: b.blockSize } : { w: e.contentRect.width, h: e.contentRect.height };
}

/** Height of the map stage (<main>, which persists across views), tracked by one shared ResizeObserver. */
let stageH = -1;
let stageWatched = false;
function watchStage(): void {
  const main = stageWatched ? null : document.querySelector('main');
  if (!main) return;
  stageWatched = true;
  new ResizeObserver(([e]) => {
    if (e) stageH = boxSize(e).h;
  }).observe(main);
}
function stageHeight(from: Element): number {
  if (stageH >= 0) return stageH;
  return from.closest('main')?.getBoundingClientRect().height ?? 0; // not observed yet (rare)
}

export function section(title: string | null, ...children: (Node | null | false)[]): HTMLElement {
  return h('section', { class: 'psec' }, title ? h('h2', { class: 'psec-title' }, title) : null, ...children);
}

/** Labelled native <select>. */
export function select<T extends string>(label: string, options: { value: T; label: string }[], value: T, onChange: (v: T) => void, cls = ''): HTMLElement {
  const id = nextId('sel');
  const sel = h('select', { id, class: 'select', on: { change: () => onChange(sel.value as T) } },
    ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  return h('div', { class: `field ${cls}` }, h('label', { for: id, class: 'field-label' }, label), h('div', { class: 'select-wrap' }, sel, icon('chevronDown', 'icon select-chevron')));
}

/** Segmented control built on native radio inputs (keyboard: arrow keys). */
export function segmented<T extends string>(label: string, options: { value: T; label: string; icon?: IconName; swatch?: string }[], value: T, onChange: (v: T) => void): HTMLElement {
  const name = nextId('seg');
  return h('fieldset', { class: 'field seg' },
    h('legend', { class: 'field-label' }, label),
    h('div', { class: 'seg-track' },
      ...options.map((o) => {
        const input = h('input', { type: 'radio', name, value: o.value, checked: o.value === value, class: 'seg-input', on: { change: () => onChange(o.value) } });
        return h('label', { class: 'seg-opt' }, input, h('span', { class: 'seg-face' },
          o.swatch ? h('span', { class: 'swatch', style: { '--sw': o.swatch }, 'aria-hidden': 'true' }) : null,
          o.icon ? icon(o.icon) : null, o.label));
      })));
}

export function toggle(label: string, checked: boolean, onChange: (v: boolean) => void, iconName?: IconName): HTMLElement {
  const input = h('input', { type: 'checkbox', role: 'switch', class: 'switch-input', checked, on: { change: () => onChange(input.checked) } });
  return h('label', { class: 'switch' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })),
    iconName ? icon(iconName) : null, h('span', { class: 'switch-label' }, label));
}

export interface KpiSpec {
  label: string;
  value: string;
  sub?: string;
  tone?: 'local' | 'imported' | 'neutral';
  trend?: 'up' | 'down' | 'flat';
  /** Explanation shown as tooltip and to screen readers (e.g. why no comparison). */
  note?: string;
}
export function kpis(items: KpiSpec[]): HTMLElement {
  return h('div', { class: 'kpis' }, ...items.map((k) => h('div', { class: `kpi tone-${k.tone ?? 'neutral'}` },
    h('span', { class: 'kpi-label' }, k.label),
    h('span', { class: 'kpi-value' }, k.value),
    k.sub ? h('span', { class: `kpi-sub ${k.trend ? `trend-${k.trend}` : ''}`, title: k.note }, k.sub, k.note ? h('span', { class: 'sr-only' }, ` ${k.note}`) : null) : null)));
}

export function legendItem(swatch: string, label: string, shape: 'dot' | 'square' | 'line' = 'dot'): HTMLElement {
  return h('li', { class: 'legend-item' }, h('span', { class: `lg-${shape}`, style: { '--sw': swatch }, 'aria-hidden': 'true' }), h('span', null, label));
}

/** Accessible data table inside a native disclosure. */
export function dataTable(summary: string, head: string[], rows: (string | number)[][], numericFrom = 1): HTMLElement {
  const table = h('table', { class: 'data-table' },
    h('thead', null, h('tr', null, ...head.map((c, i) => h('th', { scope: 'col', class: i >= numericFrom ? 'num' : '' }, c)))),
    h('tbody', null, ...rows.map((r) => h('tr', null, ...r.map((c, i) => (i === 0 ? h('th', { scope: 'row' }, String(c)) : h('td', { class: i >= numericFrom ? 'num' : '' }, String(c))))))));
  return h('details', { class: 'table-details' }, h('summary', null, summary), h('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': summary }, table));
}

export function loadingBlock(text = t('app.loading')): HTMLElement {
  return h('div', { class: 'view-loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
}

export function warningText(w: DataWarning): string {
  const vars = { year: w.year ?? '', got: fmtNum(w.got), expected: fmtNum(w.expected), code: w.code };
  if (w.code === 'cases-shortfall') return t('warn.casesShortfall', { ...vars, type: w.type === 'imported' ? t('warn.typeImported') : w.type === 'local' ? t('warn.typeLocal') : '' });
  if (w.code === 'imported-shortfall') return t(w.year != null ? 'warn.importedShortfallYear' : 'warn.importedShortfallAll', vars);
  return t('warn.generic', vars);
}

export function keptYearText(k: KeptYear): string {
  return k.at ? t('warn.keptYear', { year: k.year, date: fmtDateTime(k.at) }) : t('warn.keptYearNoDate', { year: k.year });
}

/** Inline data-quality notice. */
export function notice(texts: string[]): HTMLElement | null {
  if (!texts.length) return null;
  return h('div', { class: 'notice-warn', role: 'note' }, icon('alert'), h('div', null, ...texts.map((s) => h('p', null, s))));
}

/** Empty state for a source that has never been fetched (manifest: ok:false, stale:false). */
export function unavailableState(): HTMLElement {
  return h('div', { class: 'empty-state', role: 'status' }, icon('clock'), h('p', { class: 'empty-body' }, t('warn.unavailable')));
}

export interface TabSpec<T extends string> {
  id: T;
  label: string;
}
/** Accessible tabs (roving tabindex, arrow keys). Returns the tab bar, a panel per tab and select(). */
export function tabs<T extends string>(label: string, items: TabSpec<T>[], active: T, onChange: (id: T) => void): { bar: HTMLElement; panels: Record<T, HTMLElement>; select(id: T): void } {
  const base = nextId('tab');
  const panels = {} as Record<T, HTMLElement>;
  const btns: HTMLButtonElement[] = [];
  const select = (id: T, focus = false) => {
    items.forEach((it, i) => {
      const on = it.id === id;
      const b = btns[i]!;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      panels[it.id].hidden = !on;
      if (on && focus) b.focus();
    });
  };
  items.forEach((it, i) => {
    const b = h('button', { type: 'button', role: 'tab', id: `${base}-${it.id}`, 'aria-controls': `${base}-p-${it.id}`, class: 'tab',
      on: {
        click: () => { select(it.id); onChange(it.id); },
        keydown: (e) => {
          const k = (e as KeyboardEvent).key;
          const d = k === 'ArrowRight' ? 1 : k === 'ArrowLeft' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          const next = items[(i + d + items.length) % items.length]!;
          select(next.id, true);
          onChange(next.id);
        },
      } }, it.label);
    btns.push(b);
    panels[it.id] = h('div', { role: 'tabpanel', id: `${base}-p-${it.id}`, 'aria-labelledby': `${base}-${it.id}`, class: 'tabpanel' });
  });
  const bar = h('div', { role: 'tablist', 'aria-label': label, class: 'tabs' }, ...btns);
  select(active);
  return { bar, panels, select: (id) => select(id) };
}

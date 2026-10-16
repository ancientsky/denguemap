// Dual-handle date range built from two native range inputs (fully keyboard accessible),
// with a daily-count histogram drawn as a single SVG path behind the track.
import { h } from '../lib/dom';

const NS = 'http://www.w3.org/2000/svg';

export interface DualRange {
  el: HTMLElement;
  set(from: number, to: number): void;
  setMax(max: number): void;
  setHistogram(counts: ArrayLike<number> | null): void;
  relabel(): void;
}

export interface DualRangeOpts {
  max: number;
  from: number;
  to: number;
  labelFrom: string;
  labelTo: string;
  format: (doy: number) => string;
  /** final=false while dragging (rAF-coalesced by caller), true on change/commit. */
  onChange: (from: number, to: number, final: boolean) => void;
}

export function dualRange(o: DualRangeOpts): DualRange {
  let max = o.max;
  const mk = (cls: string, label: string, value: number) =>
    h('input', { type: 'range', class: `range-input ${cls}`, min: '1', max: String(max), step: '1', value: String(value), 'aria-label': label });
  const a = mk('r-from', o.labelFrom, o.from);
  const b = mk('r-to', o.labelTo, o.to);
  const fill = h('div', { class: 'range-fill' });
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'range-hist');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('preserveAspectRatio', 'none');
  const path = document.createElementNS(NS, 'path');
  const pathIn = document.createElementNS(NS, 'path');
  path.setAttribute('class', 'hist-all');
  pathIn.setAttribute('class', 'hist-in');
  const clip = document.createElementNS(NS, 'clipPath');
  const clipId = `clip-${Math.random().toString(36).slice(2, 8)}`;
  clip.setAttribute('id', clipId);
  const clipRect = document.createElementNS(NS, 'rect');
  clip.append(clipRect);
  pathIn.setAttribute('clip-path', `url(#${clipId})`);
  svg.append(clip, path, pathIn);
  const labA = h('span', { class: 'range-label' });
  const labB = h('span', { class: 'range-label' });
  const el = h('div', { class: 'range' },
    h('div', { class: 'range-vals' }, labA, h('span', { class: 'range-sep', 'aria-hidden': 'true' }, '→'), labB),
    h('div', { class: 'range-track' }, h('div', { class: 'range-inner', 'aria-hidden': 'true' }, svg, h('div', { class: 'range-rail' }), fill), a, b));

  const val = () => [Number(a.value), Number(b.value)] as const;
  function paint(): void {
    const [f, t] = val();
    const span = Math.max(1, max - 1);
    const p0 = ((f - 1) / span) * 100, p1 = ((t - 1) / span) * 100;
    fill.style.left = `${p0}%`;
    fill.style.width = `${Math.max(0, p1 - p0)}%`;
    clipRect.setAttribute('x', String(f - 1));
    clipRect.setAttribute('y', '0');
    clipRect.setAttribute('width', String(t - f + 1));
    clipRect.setAttribute('height', '100');
    const fa = o.format(f), fb = o.format(t);
    labA.textContent = fa;
    labB.textContent = fb;
    a.setAttribute('aria-valuetext', fa);
    b.setAttribute('aria-valuetext', fb);
    // Keep the from-thumb reachable when both thumbs sit at the max.
    a.style.zIndex = f >= max - 1 ? '4' : '3';
  }
  function handle(which: 'a' | 'b', final: boolean): void {
    let [f, t] = val();
    if (f > t) {
      if (which === 'a') b.value = String((t = f));
      else a.value = String((f = t));
    }
    paint();
    o.onChange(f, t, final);
  }
  a.addEventListener('input', () => handle('a', false));
  b.addEventListener('input', () => handle('b', false));
  a.addEventListener('change', () => handle('a', true));
  b.addEventListener('change', () => handle('b', true));
  paint();

  return {
    el,
    set(f, t) {
      a.value = String(f);
      b.value = String(t);
      paint();
    },
    setMax(m) {
      max = m;
      a.max = b.max = String(m);
      paint();
    },
    setHistogram(counts) {
      if (!counts || !counts.length) {
        path.setAttribute('d', '');
        pathIn.setAttribute('d', '');
        return;
      }
      let peak = 0;
      for (let i = 0; i < counts.length; i++) peak = Math.max(peak, counts[i]!);
      svg.setAttribute('viewBox', `0 0 ${counts.length} 100`);
      let d = '';
      if (peak > 0) {
        for (let i = 0; i < counts.length; i++) {
          const v = counts[i]!;
          if (!v) continue;
          const hgt = Math.max(6, Math.sqrt(v / peak) * 100);
          d += `M${i} 100V${(100 - hgt).toFixed(1)}h0.85V100z`;
        }
      }
      path.setAttribute('d', d);
      pathIn.setAttribute('d', d);
    },
    relabel: paint,
  };
}

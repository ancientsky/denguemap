// Static SVG icons built with createElementNS from hard-coded shape tables (no markup parsing).
// 24×24, stroke-based, currentColor.

type Shape = [tag: 'path' | 'circle' | 'rect', attrs: Record<string, string | number>];

const P = (d: string): Shape => ['path', { d }];
const C = (cx: number, cy: number, r: number, fill = false): Shape => ['circle', { cx, cy, r, ...(fill ? { fill: 'currentColor', stroke: 'none' } : {}) }];

const ICONS = {
  map: [P('M9 4 3 6.2v13.6L9 18l6 2 6-2.2V4.2L15 6 9 4z'), P('M9 4v14'), P('M15 6v14')],
  clusters: [C(12, 12, 9), C(12, 12, 5), C(12, 12, 1.6, true)],
  vector: [
    C(12, 5.5, 1.8), P('M12 8.2c-1.4 0-2.3 2.1-2.3 5.2s1 6.1 2.3 6.1 2.3-3 2.3-6.1-.9-5.2-2.3-5.2z'),
    P('M10.2 10.6 4.5 7.4'), P('M13.8 10.6l5.7-3.2'), P('M10 13.8l-4 2.6'), P('M14 13.8l4 2.6'),
    P('M10.6 17.2 8.4 21'), P('M13.4 17.2l2.2 3.8'), P('M12 3.7V1.8'),
  ],
  trends: [P('M3.5 3.5v17h17'), P('M7 15.5l4-5 3 3 5.5-7')],
  imported: [C(12, 12, 9), P('M3 12h18'), P('M12 3c2.4 2.5 3.7 5.5 3.7 9s-1.3 6.5-3.7 9c-2.4-2.5-3.7-5.5-3.7-9S9.6 5.5 12 3z')],
  about: [C(12, 12, 9), P('M12 11v6'), P('M12 7.6v.01')],
  sun: [C(12, 12, 4), P('M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4')],
  moon: [P('M20 14.6A8.2 8.2 0 0 1 9.4 4 8.2 8.2 0 1 0 20 14.6z')],
  system: [['rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }], P('M8.5 20h7'), P('M12 16v4')],
  lang: [P('M4 5.5h9'), P('M8.5 3.5v2'), P('M11 5.5c-.9 4-3.3 7-7 8.8'), P('M6 9.3c1.3 2.4 3.4 4.1 6 5'), P('M13 21l4-9.5 4 9.5'), P('M14.5 17.8h5')],
  play: [['path', { d: 'M7.5 4.8v14.4L19 12z', fill: 'currentColor' }]],
  pause: [['rect', { x: 6.5, y: 5, width: 3.6, height: 14, rx: 1, fill: 'currentColor', stroke: 'none' }], ['rect', { x: 13.9, y: 5, width: 3.6, height: 14, rx: 1, fill: 'currentColor', stroke: 'none' }]],
  stop: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2, fill: 'currentColor', stroke: 'none' }]],
  download: [P('M12 3.5v11'), P('M7.5 10.5 12 15l4.5-4.5'), P('M4.5 19.5h15')],
  chevronUp: [P('M6 15l6-6 6 6')],
  chevronDown: [P('M6 9l6 6 6-6')],
  layers: [P('M12 3.5 2.5 8.5l9.5 5 9.5-5z'), P('M2.5 13l9.5 5 9.5-5')],
  hospital: [['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 4 }], P('M12 8v8M8 12h8')],
  external: [P('M14 4h6v6'), P('M20 4l-9 9'), P('M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5')],
  alert: [P('M12 3.5 2.5 20h19z'), P('M12 10v4.5'), P('M12 17.3v.01')],
  clock: [C(12, 12, 9), P('M12 7v5l3.2 2')],
  check: [C(12, 12, 9), P('M8 12.2l2.8 2.8L16.2 9')],
  close: [P('M6 6l12 12M18 6 6 18')],
  calendar: [['rect', { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2 }], P('M3.5 10h17'), P('M8 3v4M16 3v4')],
  pin: [P('M12 21s-6.5-6.2-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21z'), C(12, 9.8, 2.3)],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;
const NS = 'http://www.w3.org/2000/svg';

export function icon(name: IconName, cls = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const [tag, attrs] of ICONS[name] as Shape[]) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

/** Brand mark: rounded tile with a drop + location dot. */
export function brandMark(): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('class', 'brand-mark');
  svg.setAttribute('aria-hidden', 'true');
  const shapes: [string, Record<string, string>][] = [
    ['rect', { x: '0', y: '0', width: '32', height: '32', rx: '9', class: 'bm-tile' }],
    ['path', { d: 'M16 5.5c-4.2 5-7.6 9.3-7.6 13.4a7.6 7.6 0 0 0 15.2 0c0-4.1-3.4-8.4-7.6-13.4z', class: 'bm-drop' }],
    ['circle', { cx: '16', cy: '19.2', r: '3.1', class: 'bm-dot' }],
  ];
  for (const [tag, attrs] of shapes) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

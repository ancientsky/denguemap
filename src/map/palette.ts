// Map colours come from CSS custom properties so light/dark stay in one place (src/styles/tokens.css).

export interface Palette {
  local: string;
  imported: string;
  accent: string;
  text: string;
  halo: string;
  sea: string;
  land: string;
  border: string;
  borderStrong: string;
  risk: [string, string, string, string];
  heat: [string, string, string, string, string];
  choropleth: [string, string, string, string, string, string];
  space: string;
  rec: [string, string, string, string];
  recStroke: string;
  ns1: { fill: string; outline: string; shadow: string };
  adv: [string, string, string];
  glow: string;
  glowCore: string;
  worldLand: string;
  worldLine: string;
}

let cached: { theme: string; palette: Palette } | null = null;

/**
 * The palette for the current theme. Reading custom properties forces a style recalc, and views call this
 * often (legends, layer installs), so the result is cached per html[data-theme] value.
 */
export function readPalette(): Palette {
  const theme = document.documentElement.dataset.theme ?? '';
  if (cached?.theme === theme) return cached.palette;
  const css = getComputedStyle(document.documentElement);
  const palette = computePalette(css);
  // Only cache once the stylesheet is applied (the custom properties resolve), never the fallbacks.
  if (css.getPropertyValue('--local').trim()) cached = { theme, palette };
  return palette;
}

function computePalette(css: CSSStyleDeclaration): Palette {
  const v = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
  return {
    local: v('--local', '#d1193e'),
    imported: v('--imported', '#d97706'),
    accent: v('--accent', '#0f766e'),
    text: v('--text', '#0f172a'),
    halo: v('--map-halo', '#ffffff'),
    sea: v('--map-sea', '#dfe9f2'),
    land: v('--map-land', '#f8fafc'),
    border: v('--map-border', '#c3ccd8'),
    borderStrong: v('--map-border-strong', '#8a97a8'),
    risk: [v('--risk-0', '#9aa5b4'), v('--risk-1', '#eab308'), v('--risk-2', '#f97316'), v('--risk-3', '#dc2626')],
    heat: [v('--heat-1', 'rgba(250,204,21,0)'), v('--heat-2', '#fde047'), v('--heat-3', '#fb923c'), v('--heat-4', '#e11d48'), v('--heat-5', '#7f1d1d')],
    choropleth: [v('--ch-0', '#fff1f2'), v('--ch-1', '#fecdd3'), v('--ch-2', '#fda4af'), v('--ch-3', '#fb7185'), v('--ch-4', '#e11d48'), v('--ch-5', '#9f1239')],
    space: v('--map-space', '#0b1220'),
    rec: [v('--rec-0', '#e5484d'), v('--rec-1', '#f76b15'), v('--rec-2', '#e2a400'), v('--rec-3', '#8e98a8')],
    recStroke: v('--rec-stroke', 'rgba(17,24,39,0.7)'),
    ns1: { fill: v('--ns1-fill', '#0e7490'), outline: v('--ns1-outline', '#ffffff'), shadow: v('--ns1-shadow', 'rgba(0,0,0,0.5)') },
    adv: [v('--adv-1', '#eab308'), v('--adv-2', '#f97316'), v('--adv-3', '#dc2626')],
    glow: v('--glow', '#ea580c'),
    glowCore: v('--glow-core', '#7c2d12'),
    worldLand: v('--world-land', '#f4f6f9'),
    worldLine: v('--world-line', '#aeb9c7'),
  };
}

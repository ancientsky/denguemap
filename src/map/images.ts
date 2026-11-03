// Map icons drawn on a <canvas> at runtime and registered with map.addImage — no external sprites,
// no glyphs needed (works on the offline fallback style too).
import type { Map as MLMap } from 'maplibre-gl';

const PR = 2; // pixel ratio of generated images

function canvas(w: number, h: number): CanvasRenderingContext2D | null {
  const c = document.createElement('canvas');
  c.width = w * PR;
  c.height = h * PR;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx?.scale(PR, PR);
  return ctx;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function add(map: MLMap, id: string, ctx: CanvasRenderingContext2D): void {
  const { width, height } = ctx.canvas;
  const data = ctx.getImageData(0, 0, width, height);
  if (map.hasImage(id)) map.removeImage(id);
  map.addImage(id, { width, height, data: new Uint8Array(data.data.buffer) }, { pixelRatio: PR });
}

export interface Ns1Colors {
  fill: string;
  outline: string;
  shadow: string;
}

/** NS1 clinic: solid rounded square with a white "+" and a contrasting outline. */
export function addNs1Icon(map: MLMap, id: string, c: Ns1Colors): void {
  const s = 22;
  const ctx = canvas(s, s);
  if (!ctx) return;
  ctx.shadowColor = c.shadow;
  ctx.shadowBlur = 3;
  roundRect(ctx, 2.5, 2.5, s - 5, s - 5, 5);
  ctx.fillStyle = c.fill;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2;
  ctx.strokeStyle = c.outline;
  ctx.stroke();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(s / 2, 7);
  ctx.lineTo(s / 2, s - 7);
  ctx.moveTo(7, s / 2);
  ctx.lineTo(s - 7, s / 2);
  ctx.stroke();
  add(map, id, ctx);
}

/** NS1 cluster badge with a count (drawn on demand via 'styleimagemissing'). */
export function addCountBadge(map: MLMap, id: string, label: string, c: Ns1Colors): void {
  const w = Math.max(28, 14 + label.length * 8), h = 26;
  const ctx = canvas(w, h);
  if (!ctx) return;
  ctx.shadowColor = c.shadow;
  ctx.shadowBlur = 4;
  roundRect(ctx, 2, 2, w - 4, h - 4, 8);
  ctx.fillStyle = c.fill;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2;
  ctx.strokeStyle = c.outline;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 12.5px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, w / 2, h / 2 + 0.5);
  add(map, id, ctx);
}

/** Small risk-coloured squares for villages without a polygon (map-view overlay; distinct from case circles). */
export function addRiskSquares(map: MLMap, prefix: string, colors: readonly string[], outline: string): void {
  colors.forEach((c, r) => {
    const s = 11;
    const ctx = canvas(s, s);
    if (!ctx) return;
    roundRect(ctx, 1.5, 1.5, s - 3, s - 3, 2);
    ctx.fillStyle = c;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = outline;
    ctx.stroke();
    add(map, `${prefix}${r}`, ctx);
  });
}

/** 防疫公告 markers: blood-test station (drop) and place visited by cases (warning triangle). */
export function addAlertIcons(map: MLMap, ids: { station: string; site: string }, c: { station: string; site: string; halo: string; text: string }): void {
  const s = 26;
  const drop = canvas(s, s);
  if (drop) {
    drop.beginPath();
    drop.moveTo(s / 2, 3);
    drop.bezierCurveTo(s / 2 + 2, 8, s - 5, 12, s - 5, 16);
    drop.arc(s / 2, 16, s / 2 - 5, 0, Math.PI);
    drop.bezierCurveTo(5, 12, s / 2 - 2, 8, s / 2, 3);
    drop.closePath();
    drop.fillStyle = c.station;
    drop.fill();
    drop.lineWidth = 2;
    drop.strokeStyle = c.halo;
    drop.stroke();
    drop.strokeStyle = '#ffffff';
    drop.lineWidth = 2.2;
    drop.lineCap = 'round';
    drop.beginPath();
    drop.moveTo(s / 2, 12.5);
    drop.lineTo(s / 2, 19.5);
    drop.moveTo(s / 2 - 3.5, 16);
    drop.lineTo(s / 2 + 3.5, 16);
    drop.stroke();
    add(map, ids.station, drop);
  }
  const tri = canvas(s, s);
  if (tri) {
    tri.beginPath();
    tri.moveTo(s / 2, 3);
    tri.lineTo(s - 3, s - 4);
    tri.lineTo(3, s - 4);
    tri.closePath();
    tri.fillStyle = c.site;
    tri.fill();
    tri.lineWidth = 2;
    tri.lineJoin = 'round';
    tri.strokeStyle = c.halo;
    tri.stroke();
    tri.fillStyle = '#111827';
    tri.fillRect(s / 2 - 1.2, 9.5, 2.4, 7.5);
    tri.beginPath();
    tri.arc(s / 2, 19.5, 1.5, 0, Math.PI * 2);
    tri.fill();
    add(map, ids.site, tri);
  }
}

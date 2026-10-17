// Imported-case globe animation: day-by-day playback of imported.json events. Each case launches a
// glowing comet along the pre-computed great-circle arc to Taiwan (~1.2 s, fading trail) and a
// ripple pulses at Taiwan on arrival; country markers grow with the cumulative count.
// One requestAnimationFrame loop updates three tiny GeoJSON sources; it stops when there is nothing
// to animate, when the tab is hidden, and when the view is destroyed.
import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import { greatCircle, TAIWAN, type LngLat } from '../lib/geo';
import type { ImportedEvent } from '../lib/types';

export const SRC = { trails: 'dm-i-trails', heads: 'dm-i-heads', ripples: 'dm-i-ripples', markers: 'dm-i-markers' };
const ARC_SEGMENTS = 64;
const COMET_MS = 1200;
const RIPPLE_MS = 1000;
const TRAIL = 0.24; // fraction of the arc covered by the trail
const MAX_COMETS = 240;
const MAX_PER_EVENT = 6;
/** Days of the timeline per second at 1×. */
export const DAYS_PER_SEC = 6;

interface Comet { cc: string; t0: number }
interface Ripple { t0: number; w: number }

const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export interface AnimCallbacks {
  /** Called when the integer day changes (cumulative counts per country up to and including `day`). */
  onDay(day: number, cum: Map<string, number>, total: number): void;
  onState(playing: boolean): void;
}

export class ImportAnimator {
  readonly arcs = new Map<string, LngLat[]>();
  private comets: Comet[] = [];
  private ripples: Ripple[] = [];
  private raf = 0;
  private last = 0;
  private dayPos = 0;
  private lastDay = -1;
  private cum = new Map<string, number>();
  private total = 0;
  private evIdx = 0;
  private map: MLMap | null = null;
  playing = false;
  speed = 1;
  start = 0;
  end = 0;
  /** Countries' marker weight scale (max cumulative over the active range). */
  maxCount = 1;
  rotate = false;
  private rotateStopUntil = 0;
  private hiddenHandler = () => (document.hidden ? this.halt() : this.kick());

  constructor(
    private events: readonly ImportedEvent[],
    private coords: Map<string, LngLat>,
    private cb: AnimCallbacks,
    private reduced: boolean,
  ) {
    for (const [cc, c] of coords) this.arcs.set(cc, greatCircle(c, TAIWAN, ARC_SEGMENTS));
    document.addEventListener('visibilitychange', this.hiddenHandler);
  }

  attach(map: MLMap | null): void {
    this.map = map;
    this.dynEmpty = false;
    this.flushStatic();
    this.kick();
  }

  /** Restrict playback to [start, end] day indices and jump to `at` (default: end = static view). */
  setRange(start: number, end: number, at = end): void {
    this.start = start;
    this.end = end;
    // marker scale over the full range
    const tot = new Map<string, number>();
    for (const e of this.events) if (e[0] >= start && e[0] <= end) tot.set(e[1], (tot.get(e[1]) ?? 0) + e[2]);
    this.maxCount = Math.max(1, ...tot.values());
    this.seek(at);
  }

  /** Jump to a day: recompute cumulative counts, clear in-flight comets. */
  seek(day: number): void {
    this.dayPos = Math.min(this.end, Math.max(this.start, day));
    this.comets = [];
    this.ripples = [];
    this.cum = new Map();
    this.total = 0;
    this.evIdx = 0;
    const d = Math.floor(this.dayPos);
    for (; this.evIdx < this.events.length; this.evIdx++) {
      const e = this.events[this.evIdx]!;
      if (e[0] < this.start) continue;
      if (e[0] > d) break;
      this.cum.set(e[1], (this.cum.get(e[1]) ?? 0) + e[2]);
      this.total += e[2];
    }
    this.lastDay = d;
    this.cb.onDay(d, this.cum, this.total);
    this.flushStatic();
    this.flushDynamic(performance.now());
  }

  play(): void {
    if (this.dayPos >= this.end) this.seek(this.start);
    this.playing = true;
    this.cb.onState(true);
    this.kick();
  }
  pause(): void {
    this.playing = false;
    this.cb.onState(false);
  }
  get day(): number {
    return Math.floor(this.dayPos);
  }

  /** User touched the map: stop auto-rotation for a while. */
  interacted(): void {
    this.rotateStopUntil = performance.now() + 25_000;
  }

  destroy(): void {
    this.halt();
    this.map = null;
    document.removeEventListener('visibilitychange', this.hiddenHandler);
  }

  // ------------------------------------------------------------------ loop
  kick(): void {
    if (this.raf || document.hidden || !this.map) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }
  private halt(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.wake);
  }

  private frame(now: number): void {
    this.raf = 0;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.playing) {
      this.dayPos = Math.min(this.end, this.dayPos + dt * DAYS_PER_SEC * this.speed);
      const d = Math.floor(this.dayPos);
      if (d !== this.lastDay) {
        // process events of every day crossed this frame
        for (; this.evIdx < this.events.length; this.evIdx++) {
          const e = this.events[this.evIdx]!;
          if (e[0] < this.start) continue;
          if (e[0] > d) break;
          this.cum.set(e[1], (this.cum.get(e[1]) ?? 0) + e[2]);
          this.total += e[2];
          if (!this.reduced) {
            const k = Math.min(e[2], MAX_PER_EVENT);
            for (let i = 0; i < k && this.comets.length < MAX_COMETS; i++) this.comets.push({ cc: e[1], t0: now + i * 90 });
          }
        }
        this.lastDay = d;
        this.cb.onDay(d, this.cum, this.total);
        this.flushStatic();
      }
      if (this.dayPos >= this.end) {
        this.playing = false;
        this.cb.onState(false);
      }
    }
    // comets → ripples
    const alive: Comet[] = [];
    for (const c of this.comets) {
      if (now - c.t0 >= COMET_MS) this.ripples.push({ t0: now, w: 1 });
      else alive.push(c);
    }
    this.comets = alive;
    this.ripples = this.ripples.filter((r) => now - r.t0 < RIPPLE_MS);
    this.flushDynamic(now);
    // idle auto-rotation (never with reduced motion)
    const rotating = this.rotate && !this.reduced && !this.playing && now > this.rotateStopUntil && !!this.map && !this.map.isMoving();
    if (rotating && this.map) {
      const c = this.map.getCenter();
      this.map.jumpTo({ center: [c.lng + dt * 3, c.lat] });
    }
    if (this.playing || this.comets.length || this.ripples.length || rotating) this.kick();
    else if (this.rotate && !this.reduced && !this.playing) {
      // paused rotation (user interaction): wake up later instead of spinning an idle loop
      clearTimeout(this.wake);
      this.wake = setTimeout(() => this.kick(), Math.max(500, this.rotateStopUntil - now));
    }
  }
  private wake: ReturnType<typeof setTimeout> | undefined;

  // ------------------------------------------------------------------ sources
  private set(id: string, fc: GeoJSON.FeatureCollection): void {
    (this.map?.getSource(id) as GeoJSONSource | undefined)?.setData(fc);
  }

  /** Country markers (cumulative). */
  flushStatic(): void {
    if (!this.map) return;
    const feats: GeoJSON.Feature[] = [];
    for (const [cc, n] of this.cum) {
      const c = this.coords.get(cc);
      if (!c || !n) continue;
      feats.push({ type: 'Feature', properties: { cc, n, w: 3 + 9 * Math.sqrt(n / this.maxCount) }, geometry: { type: 'Point', coordinates: c } });
    }
    this.set(SRC.markers, { type: 'FeatureCollection', features: feats });
  }

  private dynEmpty = false;
  private flushDynamic(now: number): void {
    if (!this.map) return;
    if (!this.comets.length && !this.ripples.length) {
      if (!this.dynEmpty) {
        this.set(SRC.trails, EMPTY);
        this.set(SRC.heads, EMPTY);
        this.set(SRC.ripples, EMPTY);
        this.dynEmpty = true;
      }
      return;
    }
    this.dynEmpty = false;
    const trails: GeoJSON.Feature[] = [];
    const heads: GeoJSON.Feature[] = [];
    for (const c of this.comets) {
      const u = (now - c.t0) / COMET_MS;
      if (u < 0) continue;
      const arc = this.arcs.get(c.cc);
      if (!arc) continue;
      const pos = ease(Math.min(1, u)) * (arc.length - 1);
      const tail = Math.max(0, pos - TRAIL * (arc.length - 1));
      const coords: LngLat[] = [interp(arc, tail)];
      for (let i = Math.ceil(tail); i < pos; i++) coords.push(arc[i]!);
      const head = interp(arc, pos);
      coords.push(head);
      if (coords.length >= 2) trails.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
      heads.push({ type: 'Feature', properties: { u }, geometry: { type: 'Point', coordinates: head } });
    }
    const rip: GeoJSON.Feature[] = this.ripples.map((r) => ({ type: 'Feature', properties: { p: Math.min(1, (now - r.t0) / RIPPLE_MS) }, geometry: { type: 'Point', coordinates: TAIWAN } }));
    this.set(SRC.trails, { type: 'FeatureCollection', features: trails });
    this.set(SRC.heads, { type: 'FeatureCollection', features: heads });
    this.set(SRC.ripples, { type: 'FeatureCollection', features: rip });
  }
}

/** Point at fractional index `x` along a polyline. */
export function interp(line: readonly LngLat[], x: number): LngLat {
  const i = Math.min(line.length - 2, Math.max(0, Math.floor(x)));
  const f = Math.min(1, Math.max(0, x - i));
  const a = line[i]!, b = line[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

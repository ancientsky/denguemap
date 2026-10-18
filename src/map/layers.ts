// Layer helpers shared by the view overlays. Kept apart from host.ts, which imports MapLibre itself: a view chunk
// that imported a value from host.ts could not run (render its panel, KPIs, …) before MapLibre had downloaded.
import type { Map as MLMap } from 'maplibre-gl';

/** Remove layers then sources if present (tolerant of a replaced style). */
export function removeAll(map: MLMap, layers: string[], sources: string[]): void {
  for (const l of layers) if (map.getLayer(l)) map.removeLayer(l);
  for (const s of sources) if (map.getSource(s)) map.removeSource(s);
}

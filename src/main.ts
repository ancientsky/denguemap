import './styles/main.css';
import { App } from './app';
import { initLang } from './i18n';
import { loadAdminTopo, loadData, loadManifest } from './lib/data';
import { initEmbed } from './lib/embed';
import { parseHash } from './lib/router';
import { validateSummary } from './lib/validate';
import { initTheme } from './theme';

initEmbed(); // read ?embed/?theme/?lang before anything rewrites the URL
initTheme();
// Start the network work the first view needs now, in parallel with i18n (no waterfall behind the English
// dictionary or the view chunk). Every loader is memoised, so the app and the views reuse these requests.
const route = parseHash(location.hash).route;
const mapRoute = route === 'map' || route === 'clusters' || route === 'vector' || route === 'imported';
const manifestP = loadManifest();
if (mapRoute) {
  // MapLibre + the map host (the build also modulepreloads them from index.html, see vite.config.ts).
  const hostP = import('./map/host');
  // Boundaries (every map view but the globe; data URLs are versioned by the manifest). Requested once MapLibre
  // (~280 KB gz, the long pole for the first map paint) is in, so the two downloads don't split the bandwidth.
  if (route !== 'imported') void Promise.all([manifestP, hostP]).then(() => loadAdminTopo()).catch(() => undefined);
  else void hostP.catch(() => undefined);
}
if (route === 'map') void import('./views/map').catch(() => undefined);
// KPI cards (map) / the "no cluster" context (clusters): the summary's versioned URL needs the manifest.
if (route === 'map' || route === 'clusters') void manifestP.then(() => loadData('summary.json', validateSummary)).catch(() => undefined);
void manifestP.catch(() => undefined); // the app reports a failed manifest itself
void initLang().then(() => {
  const root = document.getElementById('app');
  if (root) new App(root);
});

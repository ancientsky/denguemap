import './styles/main.css';
import { App } from './app';
import { initLang } from './i18n';
import { initTheme } from './theme';

initTheme();
// Map routes: start fetching MapLibre + the map host in parallel with i18n/manifest (no waterfall).
const h0 = location.hash;
if (h0 === '' || h0 === '#' || /^#\/(map|clusters|vector|imported)\b/.test(h0)) void import('./map/host').catch(() => undefined);
void initLang().then(() => {
  const root = document.getElementById('app');
  if (root) new App(root);
});

// Application shell: header/nav, hash routing, view lifecycle, shared map host, freshness indicator.
import { fmtDate, fmtDateTime, fmtTsDate, getLang, langChanged, setLang, t, type MessageKey } from './i18n';
import { getManifest, loadManifest } from './lib/data';
import { $, clear, h } from './lib/dom';
import { carryDiffers, getEmbedState, openFullHash, pickCarry, stripCarry } from './lib/embed';
import { brandMark, icon, type IconName } from './lib/icons';
import { buildHash, isRouterHash, parseHash, type Params, type Route } from './lib/router';
import type { Manifest } from './lib/types';
import { sourceState } from './lib/warnings';
import type { MapHost } from './map/host';
import { cycleTheme, getThemePref, nextThemePref, themeChanged, type ThemePref } from './theme';
import type { View, ViewFactory } from './views/types';

const MAP_ROUTES: ReadonlySet<Route> = new Set(['map', 'clusters', 'vector', 'imported']);
const NAV: { route: Route; icon: IconName; key: MessageKey }[] = [
  { route: 'map', icon: 'map', key: 'nav.map' },
  { route: 'clusters', icon: 'clusters', key: 'nav.clusters' },
  { route: 'vector', icon: 'vector', key: 'nav.vector' },
  { route: 'trends', icon: 'trends', key: 'nav.trends' },
  { route: 'imported', icon: 'imported', key: 'nav.imported' },
  { route: 'about', icon: 'about', key: 'nav.about' },
];

// Each view is its own lazily-loaded chunk.
const VIEWS: Record<Route, () => Promise<{ default: ViewFactory }>> = {
  map: () => import('./views/map'),
  clusters: () => import('./views/clusters'),
  vector: () => import('./views/vector'),
  trends: () => import('./views/trends'),
  imported: () => import('./views/imported'),
  about: () => import('./views/about'),
};

export class App {
  route: Route = 'map';
  params: Params = {};
  manifest: Manifest | null = null;
  manifestError: unknown = null;
  private view: View | null = null;
  private viewRoot!: HTMLElement;
  private mapStage!: HTMLElement;
  private mapEl!: HTMLElement;
  private mapSummaryEl!: HTMLElement;
  private live!: HTMLElement;
  private nav!: HTMLElement;
  private fresh!: HTMLAnchorElement;
  private embedBar: HTMLElement | null = null;
  private embedData!: HTMLElement;
  private embedOpen!: HTMLAnchorElement;
  /** Shell params (embed/theme/lang) that arrived in the hash and must survive every hash rewrite. */
  private carry: Params = {};
  private langBtn!: HTMLButtonElement;
  private themeBtn!: HTMLButtonElement;
  private hostP: Promise<MapHost | null> | null = null;
  private host: MapHost | null = null;
  private navToken = 0;
  private manifestP: Promise<Manifest | null>;

  constructor(private readonly root: HTMLElement) {
    this.buildShell();
    this.manifestP = loadManifest().then(
      (m) => {
        this.manifest = m;
        this.renderFreshness();
        return m;
      },
      (e: unknown) => {
        this.manifestError = e;
        this.renderFreshness();
        return null;
      },
    );
    window.addEventListener('hashchange', () => this.onHash());
    langChanged.on(() => this.onLang());
    themeChanged.on(() => {
      this.host?.setTheme();
      this.renderThemeBtn();
    });
    this.onHash();
  }

  whenManifest(): Promise<Manifest | null> {
    return this.manifestP;
  }

  // ------------------------------------------------------------------ shell
  private buildShell(): void {
    const skip = h('a', { class: 'skip-link', href: '#main', on: { click: (e) => { e.preventDefault(); $('#main')?.focus(); } } }, t('app.skip'));
    const brand = h('a', { class: 'brand', href: '#/map' }, brandMark(),
      h('span', { class: 'brand-text' }, h('span', { class: 'brand-name' }), h('span', { class: 'brand-alt' })));
    this.nav = h('nav', { class: 'primary-nav' },
      h('ul', null, ...NAV.map((n) => h('li', null, h('a', { href: `#/${n.route}`, dataset: { route: n.route } }, icon(n.icon), h('span', { class: 'nav-label' }))))));
    this.fresh = h('a', { class: 'freshness', href: '#/about' }, icon('clock'), h('span', { class: 'fresh-text' }));
    this.langBtn = h('button', { type: 'button', class: 'icon-btn lang-btn', on: { click: () => void setLang(getLang() === 'zh' ? 'en' : 'zh') } }, icon('lang'), h('span', { class: 'lang-short' }));
    this.themeBtn = h('button', { type: 'button', class: 'icon-btn theme-btn', on: { click: () => cycleTheme() } });
    const header = h('header', { class: 'topbar' }, brand, this.nav, h('div', { class: 'top-actions' }, this.fresh, this.langBtn, this.themeBtn));
    this.mapEl = h('div', { class: 'map', id: 'map', role: 'region', 'aria-describedby': 'map-summary' });
    this.mapSummaryEl = h('p', { class: 'sr-only', id: 'map-summary' });
    this.mapStage = h('div', { class: 'map-stage', hidden: true }, this.mapEl, this.mapSummaryEl);
    this.viewRoot = h('div', { class: 'view', id: 'view' });
    const main = h('main', { id: 'main', tabindex: '-1' }, this.mapStage, this.viewRoot);
    this.live = h('div', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true', id: 'live' });
    clear(this.root);
    this.root.append(skip, header, main, this.live);
    if (getEmbedState().embed) this.buildEmbedBar();
    this.renderShellText();
  }

  /** Embed mode: always-visible strip with a link to the full site (same view + state) and the data line. */
  private buildEmbedBar(): void {
    this.embedOpen = h('a', { class: 'embed-open', href: './#/map', target: '_blank', rel: 'noopener noreferrer' },
      brandMark(), h('span', { class: 'embed-open-text' }), icon('external'));
    this.embedData = h('span', { class: 'embed-data' });
    this.embedBar = h('footer', { class: 'embed-bar' }, this.embedOpen, this.embedData);
    this.root.append(this.embedBar);
  }

  private renderEmbedBar(): void {
    if (!this.embedBar) return;
    const m = this.manifest;
    let text = '';
    let warn = false;
    if (!m) {
      warn = !!this.manifestError;
      text = warn ? t('common.loadError') : '';
    } else if (m.fixture) {
      warn = true;
      text = t('embed.dataFixture');
    } else {
      warn = Object.values(m.sources).some((s) => sourceState(s) !== 'fresh');
      text = t('embed.data', { date: fmtTsDate(m.generatedAt) }) + (warn ? ` · ${t('fresh.stale')}` : '');
    }
    this.embedBar.classList.toggle('warn', warn);
    this.embedData.textContent = text;
    this.embedData.title = text;
    this.embedOpen.querySelector('.embed-open-text')!.textContent = t('embed.open');
    this.embedOpen.title = t('embed.openTitle');
    this.embedOpen.setAttribute('aria-label', t('embed.openTitle'));
    this.renderEmbedLink();
  }

  /** Same view + state, no embed flag (language always kept; theme only when the host chose one). */
  private renderEmbedLink(): void {
    if (!this.embedBar) return;
    this.embedOpen.setAttribute('href', `./${openFullHash(this.route, this.params, getLang(), getEmbedState().theme)}`);
  }

  private renderShellText(): void {
    $('.skip-link', this.root)!.textContent = t('app.skip');
    $('.brand-name', this.root)!.textContent = t('app.name');
    $('.brand-alt', this.root)!.textContent = t('app.nameAlt');
    $('.brand', this.root)!.setAttribute('aria-label', `${t('app.name')} — ${t('nav.map')}`);
    this.nav.setAttribute('aria-label', t('nav.label'));
    for (const n of NAV) {
      const a = this.nav.querySelector<HTMLElement>(`a[data-route="${n.route}"]`)!;
      a.querySelector('.nav-label')!.textContent = t(n.key);
    }
    this.langBtn.setAttribute('aria-label', t('lang.switchTo'));
    this.langBtn.title = t('lang.switchTo');
    this.langBtn.querySelector('.lang-short')!.textContent = t('lang.short');
    this.langBtn.lang = getLang() === 'zh' ? 'en' : 'zh-Hant-TW';
    this.mapEl.setAttribute('aria-label', t('map.regionLabel'));
    this.renderThemeBtn();
    this.renderFreshness();
    this.renderNavCurrent();
  }

  private renderThemeBtn(): void {
    const pref = getThemePref();
    const name = (p: ThemePref) => t(`theme.${p}` as MessageKey);
    const label = t('theme.label', { current: name(pref), next: name(nextThemePref(pref)) });
    clear(this.themeBtn);
    this.themeBtn.append(icon(pref === 'system' ? 'system' : pref === 'light' ? 'sun' : 'moon'));
    this.themeBtn.setAttribute('aria-label', label);
    this.themeBtn.title = label;
  }

  private renderFreshness(): void {
    this.renderEmbedBar();
    const textEl = this.fresh.querySelector('.fresh-text')!;
    const m = this.manifest;
    if (!m) {
      textEl.textContent = this.manifestError ? t('common.loadError') : t('app.loading');
      this.fresh.classList.toggle('warn', !!this.manifestError);
      return;
    }
    const stale = Object.entries(m.sources).filter(([, s]) => sourceState(s) !== 'fresh')
      .map(([k, s]) => (sourceState(s) === 'stale' ? t('fresh.staleItem', { name: t(`about.src.${k}` as MessageKey), time: fmtDateTime(s.fetchedAt, true) }) : t('fresh.unavailableItem', { name: t(`about.src.${k}` as MessageKey) })));
    clear(textEl);
    if (m.fixture) {
      // Synthetic fixtures must never pass for real data.
      textEl.append(h('span', { class: 'fresh-main' }, t('fresh.fixture')), h('span', { class: 'fresh-sub' }, t('fresh.fixtureSub')));
      this.fresh.classList.add('warn');
      this.fresh.title = t('fresh.fixtureTitle');
      this.fresh.setAttribute('aria-label', t('fresh.fixtureTitle'));
      document.body.classList.add('is-fixture');
      return;
    }
    textEl.append(
      h('span', { class: 'fresh-main' }, t('fresh.label', { time: fmtDateTime(m.generatedAt) })),
      h('span', { class: 'fresh-sub' }, stale.length ? t('fresh.stale') : t('fresh.latest', { date: fmtDate(m.latestOnset, 'short') })),
    );
    this.fresh.classList.toggle('warn', stale.length > 0);
    const title = t('fresh.title', { time: fmtDateTime(m.generatedAt, true), date: fmtDate(m.latestOnset) }) +
      (stale.length ? `。${t('fresh.staleTitle', { list: stale.join('、') })}` : '');
    this.fresh.title = title;
    this.fresh.setAttribute('aria-label', title);
  }

  private renderNavCurrent(): void {
    for (const a of this.nav.querySelectorAll<HTMLElement>('a[data-route]')) {
      if (a.dataset.route === this.route) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  // ------------------------------------------------------------------ routing
  private onHash(): void {
    if (!isRouterHash(location.hash)) return; // in-page anchors
    const { route, params: raw } = parseHash(location.hash);
    // embed/theme/lang are shell params: views never see them. Outside embed mode they are consumed at
    // startup and dropped from the hash (so the toggles stay authoritative); in embed mode they are
    // carried across every hash rewrite so shareable state keeps them.
    if (getEmbedState().embed) this.carry = { ...this.carry, ...pickCarry(raw) };
    const params = stripCarry(raw);
    if (carryDiffers(raw, this.carry)) history.replaceState(history.state, '', buildHash(route, { ...this.carry, ...params }));
    if (route === this.route && this.view) {
      this.params = params;
      this.renderEmbedLink();
      if (this.view.update) this.view.update(params);
      else void this.mountView();
      return;
    }
    this.route = route;
    this.params = params;
    this.renderEmbedLink();
    void this.mountView(true);
  }

  private async mountView(routeChanged = false): Promise<void> {
    const token = ++this.navToken;
    this.view?.destroy();
    this.view = null;
    this.host?.setOverlay(null);
    this.host?.hidePopup();
    clear(this.viewRoot);
    // data-view-ready names the route whose view has finished mounting (read by the smoke test); unlike
    // data-ready it is cleared on every navigation, so a stale value can't pass for the new view.
    delete document.body.dataset.viewReady;
    const isMap = MAP_ROUTES.has(this.route);
    document.body.dataset.route = this.route;
    document.body.dataset.layout = isMap ? 'map' : 'page';
    this.mapStage.hidden = !isMap;
    this.viewRoot.classList.toggle('view-page', !isMap);
    this.renderNavCurrent();
    if (isMap && this.host) this.host.resize();
    this.viewRoot.append(h('div', { class: 'view-loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), t('app.loading')));
    try {
      const mod = await VIEWS[this.route]();
      if (token !== this.navToken) return;
      clear(this.viewRoot);
      const v = await mod.default({ app: this, root: this.viewRoot, params: this.params });
      if (token !== this.navToken) {
        v.destroy();
        return;
      }
      this.view = v;
      if (routeChanged && !isMap) window.scrollTo(0, 0);
      document.body.dataset.ready = '1';
      document.body.dataset.viewReady = this.route;
    } catch (e) {
      if (token !== this.navToken) return;
      console.warn(e);
      clear(this.viewRoot);
      this.viewRoot.append(errorCard(String((e as Error)?.message ?? e), () => void this.mountView()));
    }
  }

  private onLang(): void {
    if (this.carry.lang) this.carry = { ...this.carry, lang: getLang() };
    this.renderShellText();
    this.host?.setLang(getLang());
    void this.mountView();
  }

  /** Update the URL query for the current view without re-rendering (shareable state). */
  setParams(params: Params): void {
    this.params = params;
    this.renderEmbedLink();
    const hash = buildHash(this.route, { ...this.carry, ...params });
    if (hash !== location.hash) history.replaceState(history.state, '', hash);
  }

  // ------------------------------------------------------------------ map host
  getMapHost(): Promise<MapHost | null> {
    if (!this.hostP) {
      this.hostP = import('./map/host').then(
        ({ MapHost }) => {
          try {
            this.host = new MapHost(this.mapEl);
            this.host.setLang(getLang());
            this.host.basemapChanged.on((mode) => {
              if (mode === 'fallback') this.toast(t('common.offlineBasemap'));
            });
            return this.host;
          } catch (e) {
            console.warn('Map unavailable', e);
            this.mapStage.append(h('p', { class: 'map-unavailable' }, icon('alert'), t('common.mapUnavailable')));
            return null;
          }
        },
        (e: unknown) => {
          console.warn(e);
          return null;
        },
      );
    }
    return this.hostP;
  }

  // ------------------------------------------------------------------ a11y + feedback
  /** Text alternative for the map canvas (referenced by aria-describedby). */
  mapSummary(text: string): void {
    this.mapSummaryEl.textContent = text;
  }

  private announceTimer: ReturnType<typeof setTimeout> | undefined;
  announce(text: string): void {
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => (this.live.textContent = text), 450);
  }

  toast(text: string): void {
    const el = h('div', { class: 'toast', role: 'status' }, icon('alert'), h('span', null, text));
    this.mapStage.append(el);
    setTimeout(() => el.classList.add('out'), 6000);
    setTimeout(() => el.remove(), 6600);
  }

  getManifestNow(): Manifest | null {
    return this.manifest ?? getManifest();
  }
}

export function errorCard(detail: string, retry?: () => void, file?: string): HTMLElement {
  return h('div', { class: 'error-card', role: 'alert' },
    icon('alert', 'icon error-icon'),
    h('div', null,
      h('p', { class: 'error-title' }, t('common.loadError')),
      h('p', { class: 'error-body' }, t('common.loadErrorBody', { file: file ?? detail })),
      retry ? h('button', { type: 'button', class: 'btn', on: { click: retry } }, t('common.retry')) : null));
}

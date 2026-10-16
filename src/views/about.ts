// #/about — 資料說明: sources, cadence, privacy, risk definitions, disclaimer, per-source freshness.
import { fmtDate, fmtDateTime, fmtNum, t, type MessageKey } from '../i18n';
import { extLink, h } from '../lib/dom';
import { icon, type IconName } from '../lib/icons';
import type { View, ViewContext } from './types';
import { warningText } from './ui';
import { sourceState } from '../lib/warnings';

const SOURCES = ['cases', 'imported', 'notices', 'clusters', 'vector', 'ns1'] as const;

export default async function aboutView(ctx: ViewContext): Promise<View> {
  const { app, root } = ctx;
  const card = (ic: IconName, title: string, ...children: (Node | null)[]) =>
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('div', { class: 'card-icon', 'aria-hidden': 'true' }, icon(ic)), null), h('h2', { class: 'card-h' }, title), ...children);
  const linkWithIcon = (url: string, label: string) => {
    const a = extLink(url, label);
    a.append(icon('external'));
    return a;
  };

  root.append(h('header', { class: 'page-head' }, h('h1', { class: 'page-title' }, t('about.title')), h('p', { class: 'page-intro' }, t('app.description'))));

  const risk = h('ul', { class: 'def-list' }, ...([3, 2, 1, 0] as const).map((r) => h('li', { class: 'def-item' },
    h('span', { class: 'lg-square', style: { '--sw': `var(--risk-${r})` }, 'aria-hidden': 'true' }),
    h('span', { class: 'def-name' }, t(`vector.risk${r}` as MessageKey)),
    h('span', { class: 'def-text' }, t(`vector.def${r}` as MessageKey)))));

  const freshCard = card('clock', t('about.freshH'), h('div', { class: 'view-loading' }, t('app.loading')));
  const qualityList = h('ul', { class: 'quality-list' });
  const qualityCard = card('alert', t('about.qualityH'), qualityList);
  const grid = h('div', { class: 'prose' },
    card('about', t('about.sourceH'), h('p', null, t('about.source')),
      h('ul', { class: 'link-list' },
        h('li', null, linkWithIcon('https://cdcdengue.azurewebsites.net/', t('about.oldSite'))),
        h('li', null, linkWithIcon('https://www.cdc.gov.tw/Category/List/f5Ef_aQRbEKr5hJ51YgIWw', t('about.cdcLink'))),
        h('li', null, linkWithIcon('https://data.gov.tw/', 'data.gov.tw')))),
    card('calendar', t('about.cadenceH'), h('p', null, t('about.cadence'))),
    card('pin', t('about.privacyH'), h('p', null, t('about.privacy'))),
    card('vector', t('about.riskH'), risk),
    freshCard,
    qualityCard,
    card('alert', t('about.disclaimerH'), h('p', null, t('about.disclaimer')), h('p', { class: 'card-note' }, t('about.basemap'))),
    card('external', t('about.codeH'), h('p', null, t('about.code')), h('p', null, linkWithIcon('https://github.com/ancientsky/denguemap', 'github.com/ancientsky/denguemap'))),
  );
  freshCard.classList.add('wide');
  root.append(grid);

  const m = await app.whenManifest();
  const loading = freshCard.querySelector('.view-loading');
  const warns = m?.warnings ?? [];
  if (!warns.length) qualityList.append(h('li', { class: 'status-ok' }, icon('check'), t('about.qualityNone')));
  for (const w of [...warns].sort((a, b) => (a.year ?? 0) - (b.year ?? 0))) qualityList.append(h('li', null, warningText(w)));
  if (!m) {
    loading?.replaceWith(h('p', { class: 'status-stale' }, icon('alert'), t('common.loadError')));
  } else {
    const rows = SOURCES.map((k) => {
      const s = m.sources[k];
      const state = sourceState(s);
      const ok = state === 'fresh';
      const extra = s?.periodStart && s.periodEnd ? t('about.period', { from: fmtDate(s.periodStart, 'short'), to: fmtDate(s.periodEnd, 'short') })
        : s?.sourceDate ? t('about.sourceDate', { date: fmtDate(s.sourceDate) }) : '';
      return h('tr', null,
        h('th', { scope: 'row' }, t(`about.src.${k}` as MessageKey), extra ? h('span', { class: 'card-note' }, extra) : null),
        h('td', null, s ? h('span', { class: ok ? 'status-ok' : 'status-stale' }, icon(ok ? 'check' : 'alert'), ok ? t('about.ok') : state === 'stale' ? t('about.stale') : t('about.unavailable')) : '—'),
        h('td', null, fmtDateTime(s?.fetchedAt ?? null, true)),
        h('td', { class: 'num' }, s?.records != null ? fmtNum(s.records) : '—'));
    });
    loading?.replaceWith(
      h('p', null, t('about.generated', { time: fmtDateTime(m.generatedAt, true) })),
      h('div', { class: 'table-scroll table-plain', tabindex: '0', role: 'region', 'aria-label': t('about.freshH') },
        h('table', { class: 'data-table' },
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('about.colSource')), h('th', { scope: 'col' }, t('about.colStatus')), h('th', { scope: 'col' }, t('about.colFetched')), h('th', { scope: 'col', class: 'num' }, t('about.colRecords')))),
          h('tbody', null, ...rows))));
  }
  return { destroy() {} };
}

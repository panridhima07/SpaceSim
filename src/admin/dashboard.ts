// Usage dashboard: window selector, summary tiles, per-day charts, device and version
// breakdowns, all-time totals and APK download counts. DOM APIs only; data never goes
// through innerHTML.
import { barList, lineChart, type Series } from './charts';
import { fillDaily, sumOf } from './shape';
import type { AdminStats, DailyRow, DashboardOptions, DeviceTotals, Platform, ReleaseDownloads, StatsWindow } from './types';

const WEB = '#6cb4ff';
const ANDROID = '#7bd88f';
const FLIGHTS = '#f5a65b';
const MISSIONS = '#c58af9';
const IMPORTS = '#6cb4ff';
const GUEST = '#9a9aa3';

const PLATFORM_NAME: Record<Platform, string> = { web: 'Web', android: 'Android' };
const PLATFORM_COLOR: Record<Platform, string> = { web: WEB, android: ANDROID };
const PLATFORMS: Platform[] = ['web', 'android'];
const WINDOWS: StatsWindow[] = [7, 30, 90];

type DayKey = 'opens' | 'devices' | 'flights' | 'missions' | 'imports';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function message(text: string, role: 'status' | 'alert' = 'status', error = false): HTMLParagraphElement {
  const p = el('p', error ? 'admin-message admin-error' : 'admin-message', text);
  p.setAttribute('role', role);
  return p;
}

function card(title: string, ...children: Node[]): HTMLElement {
  const section = el('section', 'admin-card');
  section.append(el('h2', 'admin-card-title', title), ...children);
  return section;
}

function tile(label: string, value: number): HTMLElement {
  const box = el('div', 'admin-tile');
  box.append(el('div', 'admin-tile-label', label), el('div', 'admin-tile-value', value.toLocaleString('en-US')));
  return box;
}

function tiles(items: [string, number][]): HTMLElement {
  const row = el('div', 'admin-tiles');
  for (const [label, value] of items) row.append(tile(label, value));
  return row;
}

function table(headers: string[], rows: string[][]): HTMLElement {
  const wrap = el('div', 'admin-table-wrap');
  const t = el('table', 'admin-table');
  const thead = el('thead');
  const head = el('tr');
  for (const h of headers) head.append(el('th', undefined, h));
  thead.append(head);
  const body = el('tbody');
  for (const cells of rows) {
    const tr = el('tr');
    for (const c of cells) tr.append(el('td', undefined, c));
    body.append(tr);
  }
  t.append(thead, body);
  wrap.append(t);
  return wrap;
}

function legend(series: Series[]): HTMLElement {
  const box = el('div', 'admin-legend');
  for (const s of series) {
    const item = el('span', 'admin-legend-item');
    const dot = el('span', 'admin-dot');
    dot.style.background = s.color;
    item.append(dot, document.createTextNode(s.label));
    box.append(item);
  }
  return box;
}

function lineCard(title: string, labels: string[], series: Series[]): HTMLElement {
  return card(title, legend(series), lineChart(title, labels, series));
}

function column(rows: DailyRow[], key: DayKey): number[] {
  return rows.map((r) => r[key]);
}

function plus(a: number[], b: number[]): number[] {
  return a.map((v, i) => v + (b[i] ?? 0));
}

function deviceFor(stats: AdminStats, platform: Platform): DeviceTotals {
  return stats.devices.find((d) => d.platform === platform) ?? { platform, devices: 0, signed_in_devices: 0 };
}

function signedInCard(stats: AdminStats): HTMLElement {
  const body = el('div');
  for (const p of PLATFORMS) {
    const d = deviceFor(stats, p);
    const guest = Math.max(0, d.devices - d.signed_in_devices);
    body.append(
      el('p', 'admin-sub', `${PLATFORM_NAME[p]}: ${d.devices.toLocaleString('en-US')} devices, ${d.signed_in_devices.toLocaleString('en-US')} signed in`),
      barList([
        { label: 'Signed in', value: d.signed_in_devices, color: PLATFORM_COLOR[p] },
        { label: 'Guest', value: guest, color: GUEST },
      ]),
    );
  }
  return card('Signed in vs guest', body);
}

function versionsCard(stats: AdminStats): HTMLElement {
  const body = el('div');
  for (const p of PLATFORMS) {
    body.append(el('h3', 'admin-sub admin-sub-head', p === 'android' ? 'Android (installed app)' : 'Web'));
    const items = stats.versions
      .filter((v) => v.platform === p)
      .map((v) => ({ label: v.version || 'unknown', value: v.devices, color: PLATFORM_COLOR[p] }))
      .sort((a, b) => b.value - a.value);
    body.append(barList(items));
  }
  return card('App versions in use', body);
}

function allTimeCard(stats: AdminStats): HTMLElement {
  const t = stats.totals;
  const body = el('div');
  body.append(
    tiles([
      ['Accounts', t.accounts],
      ['Saved designs', t.designs],
      ['Uploaded files', t.uploads],
    ]),
    el('h3', 'admin-sub admin-sub-head', 'Simulation runs'),
  );
  if (t.sim_runs.length === 0) {
    body.append(el('p', 'admin-empty', 'No simulation runs yet'));
  } else {
    body.append(
      table(
        ['Kind', 'Ran on', 'Count'],
        t.sim_runs.map((r) => [r.kind || '-', r.ran_on || '-', r.count.toLocaleString('en-US')]),
      ),
    );
  }
  return card('All time', body);
}

function renderStats(stats: AdminStats): HTMLElement {
  const web = fillDaily(stats, 'web');
  const android = fillDaily(stats, 'android');
  const labels = web.map((r) => r.day);
  const sumBoth = (key: 'flights' | 'missions' | 'imports'): number => sumOf(web, key) + sumOf(android, key);

  const wrap = el('div', 'admin-stats');
  wrap.append(
    el('p', 'admin-sub', `Last ${stats.days} days, from ${stats.from} (UTC)`),
    tiles([
      ['Opens (web)', sumOf(web, 'opens')],
      ['Opens (Android)', sumOf(android, 'opens')],
      ['Devices (web)', deviceFor(stats, 'web').devices],
      ['Devices (Android)', deviceFor(stats, 'android').devices],
      ['Flights', sumBoth('flights')],
      ['Missions', sumBoth('missions')],
      ['Imports', sumBoth('imports')],
    ]),
  );

  const grid = el('div', 'admin-cards');
  grid.append(
    lineCard('Opens per day', labels, [
      { label: 'Web', color: WEB, values: column(web, 'opens') },
      { label: 'Android', color: ANDROID, values: column(android, 'opens') },
    ]),
    lineCard('Devices per day', labels, [
      { label: 'Web', color: WEB, values: column(web, 'devices') },
      { label: 'Android', color: ANDROID, values: column(android, 'devices') },
    ]),
    lineCard('Activity per day', labels, [
      { label: 'Flights', color: FLIGHTS, values: plus(column(web, 'flights'), column(android, 'flights')) },
      { label: 'Missions', color: MISSIONS, values: plus(column(web, 'missions'), column(android, 'missions')) },
      { label: 'Imports', color: IMPORTS, values: plus(column(web, 'imports'), column(android, 'imports')) },
    ]),
    signedInCard(stats),
    versionsCard(stats),
    allTimeCard(stats),
  );
  wrap.append(grid);
  return wrap;
}

function releaseTable(list: ReleaseDownloads[]): HTMLElement {
  if (list.length === 0) return message('No releases published yet.');
  return table(
    ['Release', 'Published', 'Downloads'],
    list.map((r) => [r.tag, r.published ? r.published.slice(0, 10) : '-', r.downloads.toLocaleString('en-US')]),
  );
}

export function mountDashboard(root: HTMLElement, opts: DashboardOptions): void {
  root.replaceChildren();

  let win: StatsWindow = 30;
  let request = 0;

  // Header: title, email, window picker, sign out.
  const header = el('header', 'admin-header');
  const brand = el('div', 'admin-brand');
  brand.append(el('h1', 'admin-title', 'ASTRA usage'), el('p', 'admin-email', opts.email));

  const segment = el('div', 'admin-segment');
  segment.setAttribute('role', 'group');
  segment.setAttribute('aria-label', 'Time window');
  const windowButtons = new Map<StatsWindow, HTMLButtonElement>();
  for (const w of WINDOWS) {
    const btn = el('button', 'admin-btn', `${w} days`);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(w === win));
    btn.addEventListener('click', () => selectWindow(w));
    windowButtons.set(w, btn);
    segment.append(btn);
  }

  const signOut = el('button', 'admin-btn', 'Sign out');
  signOut.type = 'button';
  signOut.addEventListener('click', () => opts.onSignOut());

  const controls = el('div', 'admin-controls');
  controls.append(segment, signOut);
  header.append(brand, controls);

  // Window-dependent content, replaced on every load.
  const statsArea = el('div', 'admin-content');

  // APK downloads: loaded once, independent of the window.
  const releasesBody = el('div');
  releasesBody.append(message('Loading…'));
  const releasesCard = card('APK downloads', releasesBody);
  releasesCard.classList.add('admin-card-wide');
  const releasesGrid = el('div', 'admin-cards');
  releasesGrid.append(releasesCard);

  const footer = el('p', 'admin-footer', 'Counts are anonymous: one random id per device, no accounts or rockets. Days are UTC.');

  const shell = el('div', 'admin-shell');
  shell.append(header, statsArea, releasesGrid, footer);
  root.append(shell);

  function syncWindowButtons(): void {
    for (const [w, btn] of windowButtons) btn.setAttribute('aria-pressed', String(w === win));
  }

  function selectWindow(w: StatsWindow): void {
    win = w;
    syncWindowButtons();
    load();
  }

  function load(): void {
    const id = ++request;
    statsArea.replaceChildren(message('Loading…'));
    Promise.resolve()
      .then(() => opts.loadStats(win))
      .then(
        (stats) => {
          if (id === request) statsArea.replaceChildren(renderStats(stats));
        },
        (err: unknown) => {
          if (id !== request) return;
          const box = el('div', 'admin-error-box');
          const retry = el('button', 'admin-btn', 'Try again');
          retry.type = 'button';
          retry.addEventListener('click', () => load());
          box.append(
            message(err instanceof Error ? err.message : 'Could not load usage.', 'alert', true),
            retry,
          );
          statsArea.replaceChildren(box);
        },
      );
  }

  Promise.resolve()
    .then(() => opts.loadReleases())
    .then(
      (list) => releasesBody.replaceChildren(releaseTable(list)),
      () => releasesBody.replaceChildren(message('Could not reach GitHub.')),
    );

  load();
}

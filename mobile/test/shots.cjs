// Screenshots of Kea for Android at phone size, without a phone: the built app (mobile/dist) in an Electron window
// with the native side stood in for (window.__keaMock), for checking layouts by eye.
//   npx electron mobile/test/shots.cjs <out dir> [kea-data.json] [unpacked library folder]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [out, dataFile, libRoot] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
fs.mkdirSync(out, { recursive: true });
const dist = path.join(__dirname, '..', 'dist', 'index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The native side, as each scenario has it. Runs in the page before the app loads.
const mock = (cfg) => `(() => {
  const cfg = ${JSON.stringify(cfg)};
  if (cfg.welcomed) localStorage.setItem('kea.welcomed', '1');
  const listeners = {};
  window.__keaMock = {
    state: async () => ({ home: cfg.paired ? 'https://mycourses.cccs.edu/d2l/home' : '', hasLogin: !!cfg.paired, signedIn: !!cfg.paired, dataFolder: cfg.paired ? 'content://x' : '', files: cfg.paired ? ['kea-data.json', 'kea-library.zip', 'phone.json'] : [], notifications: true }),
    readFile: async () => { if (!cfg.data) throw new Error('No Kea folder or file chosen yet'); return { text: cfg.data, modified: 0 }; },
    syncLibrary: async () => ({ root: cfg.lib || '', changed: false, files: 0 }),
    phoneInbox: async () => ({ items: [] }),
    takeOpenedFile: async () => ({}),
    addListener: async (ev, cb) => ((listeners[ev] = cb), { remove() {} }),
    watch: async () => {}, checkNow: async () => ({ count: 0 }), get: async () => ({ status: 404, body: '' }),
    writeFile: async () => {}, setup: async () => {}, signIn: async () => ({ signedIn: true }), allowNotifications: async () => {},
    listFiles: async () => ({ files: cfg.files || [] }),
    appInfo: async () => ({ version: '0.52.0', build: 5200 }),
    pickFiles: async () => ({ files: ['kea-data.json'] }), pickFolder: async () => ({ folder: 'x', base: 'School' }),
    unpair: async () => {}, open: async () => {}, share: async () => {}
  };
  // (No network in screenshots: the update check finds nothing.)
  const realFetch = window.fetch;
  window.fetch = (u, o) => (String(u).includes('api.github.com') ? Promise.resolve(new Response(JSON.stringify({ tag_name: cfg.update || 'v0.52.0', assets: [{ name: 'Kea-Android.apk', browser_download_url: 'x' }] }))) : realFetch(u, o));
  if (cfg.update) window.__keaMock.downloadUpdate = async () => ({ path: '/x', version: cfg.update });
})();`;

const files = [
  { path: '/f/scans/Lab 3 worksheet.pdf', name: 'Lab 3 worksheet.pdf', size: 1843200, modified: Date.now() - 3600e3, kind: 'scan' },
  { path: '/f/docs/CHE1011 Practice Final Exam Key with worked solutions.pdf', name: 'CHE1011 Practice Final Exam Key with worked solutions.pdf', size: 412000, modified: Date.now() - 864e5, kind: 'pdf' },
  { path: '/f/scans/Scan Oct 18.pdf', name: 'Scan Oct 18.pdf', size: 920000, modified: Date.now() - 3 * 864e5, kind: 'scan' }
];

// What to do in the page, by visible text.
const click = (text) => `(() => { const el = [...document.querySelectorAll('button, summary, a')].find((b) => b.innerText.trim().startsWith(${JSON.stringify(text)})); if (el) el.click(); return !!el; })()`;
// Anything wider than the screen, or a button whose text spills out of it.
const overflow = `(() => { const W = document.documentElement.clientWidth; const bad = [];
  for (const el of document.querySelectorAll('body *')) { const r = el.getBoundingClientRect(); if (!r.width) continue;
    if (r.right > W + 1) bad.push('wide: ' + (el.className || el.tagName) + ' ' + Math.round(r.right));
    if (el.matches('button, .btn') && el.scrollWidth > el.clientWidth + 2) bad.push('spills: ' + el.innerText.slice(0, 40)); }
  return [...new Set(bad)].slice(0, 12); })()`;

const scenarios = [
  { name: '01-welcome-1', cfg: {}, steps: [] },
  { name: '02-welcome-2', cfg: {}, steps: [click('Next')] },
  { name: '03-welcome-3', cfg: {}, steps: [click('Next'), click('Next')] },
  { name: '04-tools-empty', cfg: { welcomed: true }, steps: [] },
  { name: '05-tools-files', cfg: { welcomed: true, files }, steps: [] },
  { name: '06-file-sheet', cfg: { welcomed: true, files }, steps: [`document.querySelector('.file .icon').click()`] },
  { name: '07-classes-pitch', cfg: { welcomed: true }, steps: [click('Classes')] },
  { name: '08-pair-1', cfg: { welcomed: true }, steps: [click('Classes'), click('Connect my classes')] },
  { name: '09-pair-2', cfg: { welcomed: true }, steps: [click('Classes'), click('Connect my classes'), click('Kea on my computer')] },
  { name: '10-pair-2-why', cfg: { welcomed: true }, steps: [click('Classes'), click('Connect my classes'), click('Kea on my computer'), click('Why not')] },
  { name: '11-settings-tools', cfg: { welcomed: true }, steps: [`document.querySelector('[aria-label=Settings]').click()`] },
  { name: '12-today', cfg: { paired: true, data: 1 }, steps: [] },
  { name: '13-calendar', cfg: { paired: true, data: 1 }, steps: [click('Calendar')] },
  { name: '14-classes', cfg: { paired: true, data: 1 }, steps: [click('Classes')] },
  { name: '15-class', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `document.querySelector('.card.class').click()`] },
  { name: '16-inbox', cfg: { paired: true, data: 1 }, steps: [click('Inbox')] },
  { name: '17-scan-paired', cfg: { paired: true, data: 1, files }, steps: [click('Scan')] },
  { name: '18-item', cfg: { paired: true, data: 1 }, steps: [`document.querySelector('.row').click()`] },
  { name: '19-study-hub', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `document.querySelector('.card.class').click()`, click('Study')] },
  { name: '20-settings-paired', cfg: { paired: true, data: 1, update: 'v0.53.0' }, steps: [`document.querySelector('[aria-label=Settings]').click()`] },
  { name: '21-update-banner', cfg: { paired: true, data: 1, update: 'v0.53.0' }, steps: [] }
];

// (Each screen gets its own window: closing the last one mustn't end the run.)
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const data = dataFile ? fs.readFileSync(dataFile, 'utf8') : '';
  const lib = libRoot ? `file:///${libRoot.replace(/\\/g, '/')}` : '';
  const report = [];
  for (const s of scenarios) {
    const cfg = { ...s.cfg, data: s.cfg.data ? data : '', lib };
    // (The stand-in has to be there before the app's own script runs: a preload.)
    const preload = path.join(out, `.preload-${s.name}.js`);
    fs.writeFileSync(preload, mock(cfg));
    const win = new BrowserWindow({ width: 412, height: 892, x: 20, y: 20, show: true, frame: false, useContentSize: true, backgroundColor: '#131314', webPreferences: { preload, partition: `shot-${s.name}-${Date.now()}`, contextIsolation: false, sandbox: false, webSecurity: false } });
    win.webContents.on('console-message', (e) => e.level === 'error' && report.push(`${s.name} console: ${String(e.message).slice(0, 160)}`));
    await win.loadFile(dist).catch((e) => report.push(`${s.name} load: ${e.message}`));
    await sleep(1800);
    for (const step of s.steps) {
      await win.webContents.executeJavaScript(step).catch(() => {});
      await sleep(900);
    }
    await sleep(500);
    const bad = await win.webContents.executeJavaScript(overflow).catch(() => []);
    if (bad.length) report.push(`${s.name}: ${bad.join(' | ')}`);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, `${s.name}.png`), img.toPNG());
    win.destroy();
    fs.rmSync(preload, { force: true });
  }
  fs.writeFileSync(path.join(out, 'report.txt'), report.join('\n') || 'no overflow found');
  console.log(report.join('\n') || 'no overflow found');
  app.quit();
});

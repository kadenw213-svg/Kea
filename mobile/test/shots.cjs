// Screenshots of Kea for Android at phone size, without a phone: the built app (mobile/dist) in an Electron window
// with the native side stood in for (window.__keaMock), for checking layouts by eye.
//   npx electron mobile/test/shots.cjs <out dir> [kea-data.json] [unpacked library folder]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [out, dataFile, libRoot, samples] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// Sample files to open (one per kind), from a folder given as the fourth argument.
const sampleFiles = samples && fs.existsSync(samples) ? fs.readdirSync(samples).map((n) => ({ path: `file:///${path.join(samples, n).split(path.sep).join('/')}`, name: n, type: '' })) : [];
fs.mkdirSync(out, { recursive: true });
const dist = path.join(__dirname, '..', 'dist', 'index.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The native side, as each scenario has it. Runs in the page before the app loads.
const mock = (cfg) => `(() => {
  const cfg = ${JSON.stringify(cfg)};
  if (cfg.welcomed) localStorage.setItem('kea.welcomed', '1');
  if (cfg.look) localStorage.setItem('kea.look', JSON.stringify(cfg.look));
  const listeners = {};
  window.__keaMock = {
    state: async () => ({ home: cfg.paired ? 'https://mycourses.cccs.edu/d2l/home' : '', hasLogin: !!cfg.paired, signedIn: !!cfg.paired, dataFolder: cfg.paired ? 'content://x' : '', files: cfg.paired ? ['kea-data.json', 'kea-library.zip', 'phone.json'] : [], notifications: true }),
    readFile: async () => { if (!cfg.data) throw new Error('No Kea folder or file chosen yet'); return { text: cfg.data, modified: 0 }; },
    syncLibrary: async () => ({ root: cfg.lib || '', changed: false, files: 0 }),
    phoneInbox: async () => ({ items: [] }),
    takeOpenedFile: async () => (cfg.opened ? { file: cfg.opened } : {}),
    addListener: async (ev, cb) => ((listeners[ev] = cb), { remove() {} }),
    watch: async () => {}, checkNow: async () => ({ count: 0 }), get: async () => ({ status: 404, body: '' }),
    writeFile: async () => {}, setup: async () => {}, signIn: async () => ({ signedIn: true }), allowNotifications: async () => {},
    listFiles: async () => ({ files: cfg.files || [] }),
    appInfo: async () => ({ version: '0.52.0', build: 5200 }),
    pickFiles: async () => ({ files: ['kea-data.json'], from: cfg.from || 'google' }), pickFolder: async () => ({ folder: 'x', base: 'School', from: 'phone' }),
    drives: async () => ({ google: true, onedrive: false, dropbox: false }),
    unpair: async () => {}, open: async () => {}, share: async () => {},
    voices: async () => ({ voices: [
      { name: 'en-us-x-iol-local', locale: 'en-US', country: 'United States', quality: 400, online: false, isDefault: true },
      { name: 'en-us-x-sfg-local', locale: 'en-US', country: 'United States', quality: 400, online: false, isDefault: false },
      { name: 'en-gb-x-rjs-local', locale: 'en-GB', country: 'United Kingdom', quality: 300, online: false, isDefault: false },
      { name: 'en-us-x-tpd-network', locale: 'en-US', country: 'United States', quality: 500, online: true, isDefault: false }] }),
    say: async () => {},
    readAloud: async (o) => { setTimeout(() => listeners.speech && listeners.speech({ id: (o.items[3] || o.items[0]).id, index: 3, total: o.items.length, state: 'playing' }), 400); },
    readMore: async () => {},
    readControl: async () => ({ playing: false, id: '', sleepLeft: 0 })
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
const wait = (ms) => `new Promise((r) => setTimeout(r, ${ms}))`;
// Anything wider than the screen, or a button whose text spills out of it.
const overflow = `(() => { const W = document.documentElement.clientWidth; const bad = [];
  for (const el of document.querySelectorAll('body *')) { const r = el.getBoundingClientRect(); if (!r.width) continue;
    if (r.right > W + 1) bad.push('wide: ' + (el.className || el.tagName) + ' ' + Math.round(r.right));
    if (el.matches('button, .btn') && el.scrollWidth > el.clientWidth + 2) bad.push('spills: ' + el.innerText.slice(0, 40));
    // Text leaving its box: an element with its own text that reaches past the nearest box around it (a border, a
    // background or rounded corners), or text cut off inside it.
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    if (getComputedStyle(el).overflowX !== 'visible' ? false : el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) bad.push('text wider than its box: ' + el.innerText.slice(0, 40));
    for (let b = el.parentElement; b && b !== document.body; b = b.parentElement) {
      const cs = getComputedStyle(b);
      const boxed = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderRadius) > 0 || (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent');
      if (!boxed) continue;
      const o = b.getBoundingClientRect();
      if (r.right > o.right + 1 || r.left < o.left - 1 || (r.bottom > o.bottom + 1 && cs.overflowY === 'visible')) bad.push('escapes ' + (b.className || b.tagName) + ': ' + el.innerText.slice(0, 40));
      break;
    } }
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
  { name: '10b-pair-drive', cfg: { welcomed: true }, steps: [click('Classes'), click('Connect my classes'), click('Kea on my computer'), click('Change')] },
  { name: '10c-pair-onedrive', cfg: { welcomed: true }, steps: [click('Classes'), click('Connect my classes'), click('Kea on my computer'), click('Change'), click('OneDrive')] },
  { name: '10d-pair-downloads', cfg: { welcomed: true, from: 'downloads' }, steps: [click('Classes'), click('Connect my classes'), click('Kea on my computer'), click('Change'), click('Google Drive'), click('Open Google Drive')] },
  { name: '10e-pair-phone', cfg: { welcomed: true }, steps: [click('Classes'), click('Connect my classes'), click('Kea on my computer'), click('Change'), click('A folder')] },
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
  { name: '22-readings', cfg: { paired: true, data: 1 }, steps: [click('Classes'), click('Readings')] },
  { name: '23-book', cfg: { paired: true, data: 1 }, steps: [click('Classes'), click('Readings'), `document.querySelector('.reading-row').click()`, wait(3500)] },
  { name: '24-book-player', cfg: { paired: true, data: 1 }, steps: [click('Classes'), click('Readings'), `document.querySelector('.reading-row').click()`, wait(3500), `document.querySelector('[aria-label="Read aloud"]').click()`, wait(3000)] },
  { name: '25-book-voice', cfg: { paired: true, data: 1 }, steps: [click('Classes'), click('Readings'), `document.querySelector('.reading-row').click()`, wait(3500), `document.querySelector('[aria-label="Read aloud"]').click()`, wait(3000), `document.querySelector('[aria-label=Voice]').click()`] },
  { name: '26-book-look', cfg: { paired: true, data: 1, look: { page: 'sepia' } }, steps: [click('Classes'), click('Readings'), `document.querySelector('.reading-row').click()`, wait(3500), `document.querySelector('[aria-label="Page and colours"]').click()`] },
  { name: '27-book-bare', cfg: { paired: true, data: 1, look: { theme: 'black' } }, steps: [click('Classes'), click('Readings'), `document.querySelector('.reading-row').click()`, wait(3500), `document.querySelector('.bk-pages').click()`] },
  { name: '28-settings-look', cfg: { paired: true, data: 1 }, steps: [`document.querySelector('[aria-label=Settings]').click()`, `[...document.querySelectorAll('.set h2')].find((h) => h.innerText === 'APPEARANCE' || h.innerText === 'Appearance').scrollIntoView()`] },
  { name: '29-today-sepia', cfg: { paired: true, data: 1, look: { theme: 'sepia', accent: 'orange' } }, steps: [click('Classes'), click('Readings'), `document.querySelector('.reading-row').click()`, wait(2500), `document.querySelector('[aria-label=Back]').click()`, click('Today')] },
  { name: '30-light-classes', cfg: { paired: true, data: 1, look: { theme: 'light', accent: 'blue' } }, steps: [click('Classes'), click('Review only')] },
  { name: '31-class-choose', cfg: { paired: true, data: 1, look: { theme: 'dim', accent: 'teal' } }, steps: [click('Classes'), `document.querySelector('.card.class').click()`, click('Review only')] },
  { name: '32-listen', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `document.querySelector('.card.class').click()`, click('Study'), wait(1500), click('Listen'), wait(1500)] },
  { name: '33-listen-opts', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `document.querySelector('.card.class').click()`, click('Study'), wait(1500), click('Listen'), wait(1500), click('Listening options')] },
  // Quiz modes, on BIO1112's Study page (the class with sample questions in the test data).
  { name: '50-quiz', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.card.class')].find((c) => c.innerText.includes('BIO1112'))?.click()`, click('Review all'), wait(2000)] },
  { name: '51-quiz-checked', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.card.class')].find((c) => c.innerText.includes('BIO1112'))?.click()`, click('Review all'), wait(2000), `(() => { const q = document.querySelector('.st-q'); const b = q && [...q.querySelectorAll('.st-choice')]; b && b[1].click(); })()`, click('Check'), wait(800), `document.querySelector('.st-explain')?.scrollIntoView({ block: 'center' })`] },
  { name: '52-quiz-end', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.card.class')].find((c) => c.innerText.includes('BIO1112'))?.click()`, click('Review all'), wait(2000), `document.querySelector('.st-choice')?.click()`, `window.scrollTo(0, 99999)`] },
  { name: '53-flashcards', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.card.class')].find((c) => c.innerText.includes('BIO1112'))?.click()`, click('Study'), wait(1500), `document.querySelector('.hub-mode')?.click()`, wait(1500)] },
  { name: '54-learn', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.card.class')].find((c) => c.innerText.includes('BIO1112'))?.click()`, click('Study'), wait(1500), `[...document.querySelectorAll('.hub-mode')].find((b) => b.innerText.includes('Learn'))?.click()`, wait(1500)] },
  { name: '55-learn-answered', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.card.class')].find((c) => c.innerText.includes('BIO1112'))?.click()`, click('Study'), wait(1500), `[...document.querySelectorAll('.hub-mode')].find((b) => b.innerText.includes('Learn'))?.click()`, wait(1500), click('Start'), wait(800), `document.querySelector('.sm-choices button')?.click()`, wait(800)] },
  { name: '56-match', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.card.class')].find((c) => c.innerText.includes('BIO1112'))?.click()`, click('Study'), wait(1500), `[...document.querySelectorAll('.hub-mode')].find((b) => b.innerText.includes('Match'))?.click()`, wait(1500), click('Start'), wait(1200)] },
  { name: '57-review-ENG1022', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.card.class')].find((c) => c.innerText.includes('ENG1022'))?.click()`, click('Review all'), wait(2000), `(() => { const q = document.querySelector('.st-q'); const b = q && [...q.querySelectorAll('.st-choice')]; b && b[1] && b[1].click(); })()`, click('Check'), wait(800)] },
  { name: '57-review-CHE1011', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.card.class')].find((c) => c.innerText.includes('CHE1011'))?.click()`, click('Review all'), wait(2000), `(() => { const q = document.querySelector('.st-q'); const b = q && [...q.querySelectorAll('.st-choice')]; b && b[1] && b[1].click(); })()`, click('Check'), wait(800)] },
  { name: '57-review-MAT1340', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.card.class')].find((c) => c.innerText.includes('MAT1340'))?.click()`, click('Review all'), wait(2000), `(() => { const q = document.querySelector('.st-q'); const b = q && [...q.querySelectorAll('.st-choice')]; b && b[1] && b[1].click(); })()`, click('Check'), wait(800)] },
  { name: '58-stress', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.card.class')].find((c) => c.innerText.includes('BIO1112'))?.click()`, click('Study'), wait(1500), click('Answers at the end'), `[...document.querySelectorAll('.hub-sizes button')].pop()?.click()`, click('Start'), wait(2500)] },
  { name: '58-stress-nowrap', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.card.class')].find((c) => c.innerText.includes('BIO1112'))?.click()`, click('Study'), wait(1500), click('Answers at the end'), `[...document.querySelectorAll('.hub-sizes button')].pop()?.click()`, click('Start'), wait(2500), `document.head.insertAdjacentHTML('beforeend', '<style>.st-stem, .st-choice, .st-explain { overflow-wrap: normal !important }</style>')`, wait(300)] },
  ...sampleFiles.map((f, i) => ({ name: `40-open-${String(i).padStart(2, '0')}-${f.name.replace(/[^a-z0-9.]+/gi, '_')}`, cfg: { welcomed: true, opened: f }, steps: [wait(3000)] })),
  { name: '21-update-banner', cfg: { paired: true, data: 1, update: 'v0.53.0' }, steps: [] }
];

// (Software drawing: capturing pages fails on some GPUs with "UnknownVizError". KEA_OFFSCREEN=1 draws without a
// window at all, for when the screen is locked or asleep.)
app.disableHardwareAcceleration();
// (Each screen gets its own window: closing the last one mustn't end the run.)
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const data = dataFile ? fs.readFileSync(dataFile, 'utf8') : '';
  const lib = libRoot ? `file:///${libRoot.replace(/\\/g, '/')}` : '';
  const report = [];
  // (KEA_ONLY=<regex>: just the screens whose names match.)
  for (const s of scenarios.filter((x) => !process.env.KEA_ONLY || new RegExp(process.env.KEA_ONLY).test(x.name))) {
    const cfg = { ...s.cfg, data: s.cfg.data ? data : '', lib };
    // (The stand-in has to be there before the app's own script runs: a preload.)
    const preload = path.join(out, `.preload-${s.name}.js`);
    fs.writeFileSync(preload, mock(cfg));
    const win = new BrowserWindow({ width: 412, height: 892, x: 20, y: 20, show: !process.env.KEA_OFFSCREEN, frame: false, useContentSize: true, backgroundColor: '#131314', webPreferences: { offscreen: !!process.env.KEA_OFFSCREEN, preload, partition: `shot-${s.name}-${Date.now()}`, contextIsolation: false, sandbox: false, webSecurity: false } });
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

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
    readControl: async () => ({ playing: false, id: '', sleepLeft: 0 }),
    // (The Kea accounts kept on the phone: in memory for screenshots.)
    accountsRead: async () => ({ text: sessionStorage.getItem('shots.accounts') || '' }),
    accountsWrite: async ({ text }) => sessionStorage.setItem('shots.accounts', text),
    takeOauth: async () => ({})
  };
  // (No network in screenshots: the update check finds nothing.)
  const realFetch = window.fetch;
  window.fetch = (u, o) => (String(u).includes('api.github.com') ? Promise.resolve(new Response(JSON.stringify({ tag_name: cfg.update || 'v0.52.0', assets: [{ name: 'Kea-Android.apk', browser_download_url: 'x' }] }))) : realFetch(u, o));
  if (cfg.update) window.__keaMock.downloadUpdate = async () => ({ path: '/x', version: cfg.update });
  // A real Kea Hub (KEA_HUB=<url> KEA_HUB_TOKEN=<session token>, for example a scratch one): the native Hub client,
  // stood in for with plain requests that carry the token.
  if (cfg.hub) {
    Object.assign(window.__keaMock, {
      hubState: async () => ({ url: cfg.hub.url, signedIn: true, email: cfg.hub.email || '', root: '' }),
      hubSetUrl: async () => {}, hubForget: async () => {},
      hubRequest: async (o) => {
        const r = await realFetch(cfg.hub.url + o.path, { method: o.method, headers: { 'content-type': o.contentType || 'application/json', authorization: 'Bearer ' + cfg.hub.token }, body: o.body });
        return { status: r.status, body: await r.text(), version: (r.headers.get('etag') || '').replace(/"/g, '') };
      },
    });
  }
  // Work (cfg.work): an account online on a Kea account server with one hosted organization, as a manager there.
  // (cfg.work === 'offline': nothing answers, and the copy saved last time is shown.)
  if (cfg.work) {
    const H = 3600e3, now = Date.now(), iso = (t) => new Date(t).toISOString();
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const at = (d, h) => day0.getTime() + d * 864e5 + h * H;
    const shift = (id, d, h, len, pos, extra) => Object.assign({ id: id, scheduleId: 'sc1', accountId: 'me1', name: 'Sam Rivera', positionId: 'p1', positionName: pos, departmentId: null, date: iso(at(d, h)).slice(0, 10), start: iso(at(d, h)), end: iso(at(d, h + len)), startAt: at(d, h), endAt: at(d, h + len), status: 'published', note: null, swap: null }, extra || {});
    const org = { id: 'o1', name: 'Westside Pool', tz: Intl.DateTimeFormat().resolvedOptions().timeZone, status: 'active', role: 'manager', memberStatus: 'active', members: 14 };
    const abilities = ['clock.self', 'timeoff.request', 'people.view', 'people.approve', 'schedule.view', 'schedule.edit', 'schedule.publish', 'swaps.decide', 'timecards.view', 'timecards.approve', 'timeoff.decide'];
    const mine = [shift('s1', 0, 15, 4, 'Lifeguard'), shift('s2', 1, 9, 6, 'Swim instructor', { note: 'Lesson block B' }), shift('s3', 3, 15, 4, 'Lifeguard')];
    const routes = {
      '/v1/health': { ok: true, service: 'keac', features: ['pass', 'hostedOrgs', 'google', 'microsoft'] },
      '/v1/me': { account: { id: 'acc1', email: 'sam@example.com', displayName: 'Sam Rivera' }, storage: { used: 0, quota: 5e9 } },
      '/v1/orgs': { orgs: [org] },
      '/v1/orgs/o1': { org: org, me: { id: 'me1', role: 'manager', status: 'active', abilities: abilities, scopes: {} } },
      '/v1/orgs/o1/my-shifts': { shifts: mine },
      '/v1/orgs/o1/swaps': { swaps: [{ id: 'w1', shiftId: 'x9', from: 'u2', fromName: 'Jordan Lee', claimant: null, claimantName: null, note: 'Family trip', status: 'offered', shift: shift('x9', 2, 12, 4, 'Lifeguard', { accountId: 'u2', name: 'Jordan Lee' }) }, { id: 'w2', shiftId: 'x8', from: 'u3', fromName: 'Ava Chen', claimant: 'u4', claimantName: 'Noah Park', note: null, status: 'claimed', shift: shift('x8', 4, 8, 5, 'Front desk', { accountId: 'u3', name: 'Ava Chen' }) }] },
      '/v1/orgs/o1/forms': { forms: [{ id: 'f1', title: 'Availability, Dec 15 – 28', status: 'open', submittedAt: null, deadlineAt: now + 3 * 864e5, periodStart: '2026-12-15', periodEnd: '2026-12-28' }] },
      '/v1/orgs/o1/clock': { clockedIn: false, punch: null, canClock: true, period: { start: iso(at(-3, 0)).slice(0, 10), end: iso(at(10, 0)).slice(0, 10) }, defaultPayCodeId: 'pc1' },
      '/v1/orgs/o1/clock/today': { date: iso(now).slice(0, 10), shifts: [{ shiftId: 's1', accountId: 'me1', positionName: 'Lifeguard', start: iso(at(0, 15)), end: iso(at(0, 19)), state: 'upcoming', minutesLate: 0 }] },
      '/v1/orgs/o1/me/pay': { period: { start: iso(at(-3, 0)).slice(0, 10), end: iso(at(10, 0)).slice(0, 10) }, current: { start: iso(at(-3, 0)).slice(0, 10), end: iso(at(10, 0)).slice(0, 10) }, codes: [{ id: 'pc1', name: 'Lifeguard', color: '#2a7fff', active: true, default: true, rateCents: 1850 }, { id: 'pc2', name: 'Swim instructor', color: '#21a67a', active: true, default: false, rateCents: 2200 }], defaultCodeId: 'pc1', hours: [{ codeId: 'pc1', name: 'Lifeguard', rateCents: 1850, minutes: 960, hours: 16 }, { codeId: 'pc2', name: 'Swim instructor', rateCents: 2200, minutes: 360, hours: 6 }], totals: { workedMin: 1320, regularMin: 1320, overtimeMin: 0, doubleTimeMin: 0 }, approved: null, note: 'Pay stubs come from payroll: open Pay stubs in KeaS Payroll, or ask your payroll admin.' },
      '/v1/orgs/o1/timecards': { person: { id: 'me1', name: 'Sam Rivera' }, period: { start: iso(at(-3, 0)).slice(0, 10), end: iso(at(10, 0)).slice(0, 10) }, days: [{ date: iso(at(-2, 12)).slice(0, 10), punches: [{ id: 'p1', type: 'in', at: iso(at(-2, 9)), source: 'phone' }, { id: 'p2', type: 'out', at: iso(at(-2, 15)), source: 'phone' }], workedMin: 360, overtimeMin: 0 }, { date: iso(at(-1, 12)).slice(0, 10), punches: [{ id: 'p3', type: 'in', at: iso(at(-1, 15)), source: 'app' }, { id: 'p4', type: 'out', at: iso(at(-1, 19)), source: 'request:r1' }], workedMin: 240, overtimeMin: 0 }], totals: { workedMin: 600, overtimeMin: 0 }, flags: [], approved: null, pendingRequests: 0, timeOff: [] },
      '/v1/orgs/o1/punch-requests': { requests: [{ id: 'r2', accountId: 'u5', name: 'Mia Lopez', shiftId: 'x1', type: 'out', at: iso(at(-1, 18)), reasonCode: 'forgot', note: 'Left in a hurry', status: 'pending' }] },
      '/v1/orgs/o1/time-off': { timeOff: [{ id: 't1', accountId: 'me1', kind: 'vacation', startDate: iso(at(20, 12)).slice(0, 10), endDate: iso(at(22, 12)).slice(0, 10), hours: null, status: 'pending' }, { id: 't2', accountId: 'u6', name: 'Liam Ortiz', kind: 'sick', startDate: iso(at(2, 12)).slice(0, 10), endDate: iso(at(2, 12)).slice(0, 10), hours: null, status: 'pending' }], kinds: ['vacation', 'sick', 'personal'] },
      '/v1/orgs/o1/members': { members: [{ id: 'me1', name: 'Sam Rivera', status: 'active' }, { id: 'u2', name: 'Jordan Lee', status: 'active' }, { id: 'u3', name: 'Ava Chen', status: 'active' }], pending: [{ id: 'u9', name: 'Riley Brooks', email: 'riley@example.com', emailVerified: false, status: 'pending' }] },
      '/v1/orgs/o1/timecards/period': { period: { start: iso(at(-17, 0)).slice(0, 10), end: iso(at(-4, 0)).slice(0, 10) }, current: {}, people: [{ accountId: 'u2', name: 'Jordan Lee', workedMin: 4440, overtimeMin: 240, approved: false, flags: 1, pendingRequests: 0, mine: false }, { accountId: 'u3', name: 'Ava Chen', workedMin: 3600, overtimeMin: 0, approved: false, flags: 0, pendingRequests: 1, mine: false }] },
      '/v1/orgs/o1/schedule': { shifts: [shift('s1', 0, 15, 4, 'Lifeguard'), shift('x5', 0, 9, 6, 'Lifeguard', { accountId: 'u2', name: 'Jordan Lee' }), shift('x6', 1, 7, 5, 'Front desk', { accountId: null, name: null })] },
      '/v1/todo': { now: now, items: [{ key: 'form:o1:f1', kind: 'form', orgId: 'o1', orgName: 'Westside Pool', title: 'Say when you can work, Dec 15 – 28', detail: '', dueAt: now + 3 * 864e5, overdue: false, urgency: 2, action: { type: 'form', formId: 'f1' } }, { key: 'ack:o1:pol1', kind: 'ack', orgId: 'o1', orgName: 'Westside Pool', title: 'Read the pool safety rules', detail: 'Updated for winter hours', dueAt: null, overdue: false, urgency: 1, action: { type: 'ack', policyId: 'pol1' } }], snoozed: [] }
    };
    localStorage.setItem('kea.accountUrl', 'https://accounts.kea.test');
    sessionStorage.setItem('shots.accounts', JSON.stringify({ v: 1, active: 'a1', accounts: { a1: { id: 'a1', email: 'sam@example.com', name: 'Sam Rivera', createdAt: now - 864e5, lastSignIn: now, verifier: null, hub: { id: 'acc1', url: 'https://accounts.kea.test', provider: 'google', at: now } } } }));
    if (cfg.work === 'offline') {
      localStorage.setItem('kea.work.hosted', '1');
      localStorage.setItem('kea.work.a1', JSON.stringify({ account: 'a1', at: now - 2 * H, seen: { hub: now - 2 * H }, orgs: [Object.assign({}, org, { abilities: abilities, scopes: {}, myId: 'me1', src: 'hub', serverName: null })], shifts: mine.map((s) => Object.assign({}, s, { orgId: 'o1', orgName: org.name, tz: org.tz, src: 'hub' })), todo: routes['/v1/todo'].items.map((t) => Object.assign({}, t, { src: 'hub' })) }));
    }
    Object.assign(window.__keaMock, {
      hubState: async () => ({ url: 'https://accounts.kea.test', signedIn: true, email: 'sam@example.com', root: '' }),
      hubSetUrl: async () => {}, hubForget: async () => {},
      hubRequest: async (o) => {
        if (cfg.work === 'offline') throw new Error('timeout');
        const p = o.path.split('?')[0];
        if (o.method === 'POST') return { status: 200, body: '{"ok":true}', version: '' };
        if (p.startsWith('/v1/orgs/o1/forms/f1')) return { status: 200, body: JSON.stringify({ form: { id: 'f1', title: 'Availability, Dec 15 – 28' }, slots: [0, 1, 2, 3].map((i) => ({ key: 'k' + i, date: iso(at(7 + i, 12)).slice(0, 10), label: i % 2 ? 'Afternoon' : 'Morning', start: i % 2 ? '13:00' : '07:00', end: i % 2 ? '19:00' : '13:00' })), response: { answers: { k0: 'A', k1: 'I' } }, prefill: {}, state: { canEdit: true } }), version: '' };
        const r = routes[p];
        return r ? { status: 200, body: JSON.stringify(r), version: '' } : { status: 404, body: '{"error":"Not found."}', version: '' };
      },
      orgList: async () => ({ servers: [] }),
      takeJoin: async () => (cfg.joinLink ? { link: cfg.joinLink } : {})
    });
  }
})();`;

const files = [
  { path: '/f/scans/Lab 3 worksheet.pdf', name: 'Lab 3 worksheet.pdf', size: 1843200, modified: Date.now() - 3600e3, kind: 'scan' },
  { path: '/f/docs/CHE1011 Practice Final Exam Key with worked solutions.pdf', name: 'CHE1011 Practice Final Exam Key with worked solutions.pdf', size: 412000, modified: Date.now() - 864e5, kind: 'pdf' },
  { path: '/f/scans/Scan Oct 18.pdf', name: 'Scan Oct 18.pdf', size: 920000, modified: Date.now() - 3 * 864e5, kind: 'scan' }
];

// What to do in the page, by visible text.
const click = (text) => `(() => { const el = [...document.querySelectorAll('button, summary, a')].find((b) => b.innerText.trim().startsWith(${JSON.stringify(text)})); if (el) el.click(); return !!el; })()`;
// (Exactly this text: "Book" and not "Bookmark".)
const clickExact = (text) => `(() => { const el = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === ${JSON.stringify(text)}); if (el) el.click(); return !!el; })()`;
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

// A class's Study, its first chapter ticked, Start, and the first choice picked.
const answered = (code) => [click('Classes'), `[...document.querySelectorAll('.mcard')].find((c) => c.innerText.includes(${JSON.stringify(code)}))?.click()`, click('Study'), wait(1500), `document.querySelectorAll('.hub-tick')[2]?.click()`, wait(300), click('Start'), wait(1500), `document.querySelector('.st-choice')?.click()`, wait(800)];
// Every question has the saved lesson in KEA_LESSON (Teach shows it instead of asking the PC).
const lessonJson = process.env.KEA_LESSON && fs.existsSync(process.env.KEA_LESSON) ? fs.readFileSync(process.env.KEA_LESSON, 'utf8') : 'null';
const withLesson = `(() => { const l = ${lessonJson}; if (l) window.api.scholar.lessons = async () => [l]; })()`;
// An item's sheet, found by its title anywhere in the calendar (its week is opened first if need be).
const openItem = (title) => `(async () => { const find = () => [...document.querySelectorAll('.row')].find((r) => r.innerText.includes(${JSON.stringify(title)})); for (let i = 0; i < 8 && !find(); i++) { const m = document.querySelector('.miss-fold'); if (m && i === 0) m.click(); else [...document.querySelectorAll('button')].find((b) => /next|›|→/i.test(b.getAttribute('aria-label') || b.innerText))?.click(); await new Promise((r) => setTimeout(r, 300)); } find()?.click(); })()`;
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
  // Classes as on the PC: the calendar first, a class as its weeks, Messages and Notifications.
  { name: '60-calendar-first', cfg: { paired: true, data: 1 }, steps: [`document.querySelector('.miss-fold')?.click()`] },
  { name: '61-class-weeks', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.mcard')].find((c) => c.innerText.includes('BIO1112'))?.click()`] },
  { name: '62-class-weeks-low', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.mcard')].find((c) => c.innerText.includes('BIO1112'))?.click()`, `document.querySelector('.pw.now')?.scrollIntoView()`] },
  { name: '63-class-bottom', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.mcard')].find((c) => c.innerText.includes('CHE1011'))?.click()`, `[...document.querySelectorAll('h2')].pop()?.scrollIntoView()`] },
  { name: '64-class-grades', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.mcard')].find((c) => c.innerText.includes('BIO1112'))?.click()`, `document.querySelector('button.bigrade')?.click()`] },
  { name: '65-messages', cfg: { paired: true, data: 1 }, steps: [click('Messages')] },
  { name: '66-notifications', cfg: { paired: true, data: 1 }, steps: [click('Notifications')] },
  // Study: Weak spots on its own, an answered question with Book and Encyclopedia, a highlight looked up, the book.
  { name: '67-weak-spots', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.mcard')].find((c) => c.innerText.includes('BIO1112'))?.click()`, click('Study'), wait(1500), `[...document.querySelectorAll('.hub-ch-main')].find((b) => b.innerText.includes('Weak spots'))?.click()`, wait(300), click('Start'), wait(1500)] },
  { name: '68-stream-answered', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.mcard')].find((c) => c.innerText.includes('BIO1112'))?.click()`, click('Study'), wait(1500), `document.querySelectorAll('.hub-tick')[2]?.click()`, wait(300), click('Start'), wait(1500), `document.querySelector('.st-choice')?.click()`, wait(800)] },
  { name: '69-stream-lookup', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.mcard')].find((c) => c.innerText.includes('BIO1112'))?.click()`, click('Study'), wait(1500), `document.querySelectorAll('.hub-tick')[2]?.click()`, wait(300), click('Start'), wait(1500), `document.querySelector('.st-choice')?.click()`, wait(800), `(() => { const el = document.querySelector('.st-stream-card'); const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode()) && !/\\w{6,}/.test(n.data)); if (!n) return; const m = n.data.match(/\\w{6,}/); const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length); getSelection().removeAllRanges(); getSelection().addRange(r); })()`, wait(500), click('Look up'), wait(5000)] },
  { name: '70-stream-book', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.mcard')].find((c) => c.innerText.includes('CHE1011'))?.click()`, click('Study'), wait(1500), `document.querySelectorAll('.hub-tick')[2]?.click()`, wait(300), click('Start'), wait(1500), `document.querySelector('.st-choice')?.click()`, wait(800), clickExact('Book'), wait(4000)] },
  // Teach: on the phone it asks the PC; with a lesson saved (KEA_LESSON: a lesson's JSON), the lesson and its checks.
  { name: '71-teach-asked', cfg: { paired: true, data: 1 }, steps: [...answered('CHE1011'), click('Teach me'), wait(1200)] },
  { name: '72-teach-lesson', cfg: { paired: true, data: 1 }, steps: [...answered('CHE1011'), withLesson, click('Teach me'), wait(2500)] },
  { name: '73-teach-checks', cfg: { paired: true, data: 1 }, steps: [...answered('CHE1011'), withLesson, click('Teach me'), wait(2500), `document.querySelector('.tc-choice')?.click()`, `document.querySelector('.tc-checks')?.scrollIntoView()`, wait(500)] },
  { name: '74-teach-wide', cfg: { paired: true, data: 1, size: [1280, 800] }, steps: [...answered('CHE1011'), withLesson, click('Teach me'), wait(2500)] },
  { name: '75-teach-highlight', cfg: { paired: true, data: 1 }, steps: [...answered('CHE1011'), `document.querySelector('.st-main')?.scrollTo({ top: 0 })`, wait(200), `(() => { const el = document.querySelector('.st-stream-card'); const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode()) && !/\\w{6,}/.test(n.data)); if (!n) return; const m = n.data.match(/\\w{6,}/); const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length); getSelection().removeAllRanges(); getSelection().addRange(r); })()`, wait(600)] },
  // Assignment guides (with guides.json in the data's study folder): the item sheet, a step opened, the hand-in and
  // grading, the class site's wording folded; then a class's Readings in their own area.
  { name: '80-guide-lab', cfg: { paired: true, data: 1 }, steps: [openItem('Lab report #7'), wait(800)] },
  { name: '81-guide-step-open', cfg: { paired: true, data: 1 }, steps: [openItem('Lab report #7'), wait(800), `document.querySelectorAll('.gd-step-head:not(:disabled)')[1]?.click()`, wait(300), `document.querySelectorAll('.gd-step')[3]?.scrollIntoView({ block: 'start' })`, wait(300)] },
  { name: '82-guide-bottom', cfg: { paired: true, data: 1 }, steps: [openItem('Lab report #7'), wait(800), `document.querySelector('.gd-fold summary')?.click()`, `document.querySelector('.gd-submit')?.scrollIntoView({ block: 'start' })`, wait(300)] },
  { name: '83-guide-discussion', cfg: { paired: true, data: 1 }, steps: [openItem('Online Assignment 9: Buffers (Initial'), wait(800)] },
  { name: '84-guide-pending', cfg: { paired: true, data: 1 }, steps: [openItem('Online Assignment 9: Buffers (Response'), wait(800)] },
  { name: '85-readings-over', cfg: { paired: true, data: 1 }, steps: [click('Classes'), `[...document.querySelectorAll('.mcard')].find((c) => c.innerText.includes('CHE1011'))?.click()`, wait(300), `[...document.querySelectorAll('.class-go button')].find((b) => b.innerText.includes('Readings'))?.click()`, wait(600)] },
  { name: '89-guide-focus', cfg: { paired: true, data: 1 }, steps: [openItem('Module 3 Assignment'), wait(800), `document.querySelector('.gd-about')?.scrollIntoView({ block: 'start' })`, wait(300)] },
  { name: '87-extended-row', cfg: { paired: true, data: 1 }, steps: [`document.querySelector('.miss-fold')?.click()`, wait(400)] },
  { name: '88-extended-sheet', cfg: { paired: true, data: 1 }, steps: [openItem('Lab report #7'), wait(800)] },
  { name: '86-guide-wide', cfg: { paired: true, data: 1, size: [1280, 800] }, steps: [openItem('Lab report #7'), wait(800), `document.querySelectorAll('.gd-step-head:not(:disabled)')[1]?.click()`, wait(300)] },
  { name: '21-update-banner', cfg: { paired: true, data: 1, update: 'v0.53.0' }, steps: [] },
  // Work: shifts and swaps, the time clock with pay codes, my pay, to-dos, a manager's approvals and schedule, joining,
  // an availability form, and the saved copy while nothing answers.
  { name: 'w1-work-shifts', cfg: { welcomed: true, work: true }, steps: [click('Work'), wait(1200)] },
  { name: 'w2-work-time', cfg: { welcomed: true, work: true }, steps: [click('Work'), wait(800), clickExact('Time'), wait(1200)] },
  { name: 'w3-work-pay', cfg: { welcomed: true, work: true }, steps: [click('Work'), wait(800), clickExact('Pay'), wait(1200)] },
  { name: 'w4-work-todo', cfg: { welcomed: true, work: true }, steps: [click('Work'), wait(800), clickExact('To do'), wait(1200)] },
  { name: 'w5-work-approvals', cfg: { welcomed: true, work: true }, steps: [click('Work'), wait(800), clickExact('Manage'), wait(1500)] },
  { name: 'w6-work-schedule', cfg: { welcomed: true, work: true }, steps: [click('Work'), wait(800), clickExact('Manage'), wait(800), clickExact('Schedule'), wait(1200)] },
  { name: 'w7-work-shift-edit', cfg: { welcomed: true, work: true }, steps: [click('Work'), wait(800), clickExact('Manage'), wait(800), clickExact('Schedule'), wait(1200), `document.querySelector('.work .card.link')?.click()`, wait(800)] },
  { name: 'w8-work-form', cfg: { welcomed: true, work: true }, steps: [click('Work'), wait(1200), `document.querySelector('.work .card.link')?.click()`, wait(1000)] },
  { name: 'w9-work-join-link', cfg: { welcomed: true, work: true, joinLink: 'kea://join?s=https%3A%2F%2Fpool.example.org&c=POOL-CODE-1234' }, steps: [wait(1500)] },
  { name: 'wa-work-offline', cfg: { welcomed: true, work: 'offline' }, steps: [click('Work'), wait(1500)] },
  { name: 'wb-work-offline-time', cfg: { welcomed: true, work: 'offline' }, steps: [click('Work'), wait(800), clickExact('Time'), wait(1200)] },
  // The Kea account in Settings with a real Hub (KEA_HUB, KEA_HUB_TOKEN): the supporter badge, storage, notifications.
  ...(process.env.KEA_HUB ? [{ name: '90-account-hub', cfg: { welcomed: true, hub: { url: process.env.KEA_HUB, token: process.env.KEA_HUB_TOKEN, email: process.env.KEA_HUB_EMAIL } }, steps: [`document.querySelector('[aria-label=Settings]').click()`, wait(2500)] }] : [])
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
    const win = new BrowserWindow({ width: s.cfg.size?.[0] || 412, height: s.cfg.size?.[1] || 892, x: 20, y: 20, show: !process.env.KEA_OFFSCREEN, frame: false, useContentSize: true, backgroundColor: '#131314', webPreferences: { offscreen: !!process.env.KEA_OFFSCREEN, preload, partition: `shot-${s.name}-${Date.now()}`, contextIsolation: false, sandbox: false, webSecurity: false } });
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

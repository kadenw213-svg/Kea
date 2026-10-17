// Kea's own browser for class sites (D2L/Brightspace): a hidden window with its own saved session per profile.
// Class scans read pages through it, so nothing opens in the user's browser.
//
// Signing in is Kea's job, never Claude's: the first time, the user signs in themselves in a visible Kea window
// (and may let Kea remember the login, encrypted with Windows' own protection). Later, when a scan hits the sign-in
// page, Kea fills in that saved login itself, like a password manager. If that doesn't get through (a new prompt, a
// code from a phone), Kea shows its window and waits for the user. The tools Claude uses never see a password.
const { BrowserWindow, session, safeStorage, Notification, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const profiles = require('./profiles.cjs');

const PAGE_TIMEOUT = 45000;

// ---------- The saved class site and login (per profile) ----------
const schoolFile = () => path.join(profiles.paths().dir, 'school.bin');
function readSchool() {
  try {
    const buf = fs.readFileSync(schoolFile());
    return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8'));
  } catch {
    return {};
  }
}
function writeSchool(s) {
  fs.mkdirSync(path.dirname(schoolFile()), { recursive: true });
  const json = JSON.stringify(s);
  fs.writeFileSync(schoolFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json));
}
/** What the interface may know: the address, and whether a login is saved (never the login itself). */
function schoolInfo() {
  const s = readSchool();
  return { home: s.home || '', host: s.home ? hostOf(s.home) : '', remembers: !!s.login, loginHost: s.login?.host || '' };
}
function setHome(home) {
  const s = readSchool();
  s.home = String(home || '').trim();
  writeSchool(s);
  return schoolInfo();
}
function forgetLogin() {
  const s = readSchool();
  delete s.login;
  // Forgetting also means "don't save it again" until the user ticks the box on a new sign-in.
  s.remember = false;
  writeSchool(s);
  return schoolInfo();
}
/** Save the login the user signs in with in Kea's window: when they said so at setup (the default), any time. */
const wantsRemember = () => rememberNext || readSchool().remember !== false;

const hostOf = (u) => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return '';
  }
};

// ---------- The hidden window ----------
let win = null;
let winProfile = '';
const partition = () => `persist:class-site-${profiles.active()}`;

function getWindow() {
  if (win && !win.isDestroyed() && winProfile === profiles.active()) return win;
  if (win && !win.isDestroyed()) win.destroy();
  winProfile = profiles.active();
  win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 820,
    title: 'Kea: sign in to your class site',
    autoHideMenuBar: true,
    webPreferences: { partition: partition(), sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'browser-preload.cjs') }
  });
  // Pages can't open more windows: links that would, load here instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    win.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    // Closing the sign-in window just hides it again (the session stays), unless Kea is quitting.
    if (global.keaQuitting) return;
    e.preventDefault();
    win.hide();
  });
  return win;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Load a page and wait for it (and its scripts) to settle. */
async function load(url) {
  const w = getWindow();
  const done = new Promise((resolve) => {
    const t = setTimeout(resolve, PAGE_TIMEOUT);
    w.webContents.once('did-stop-loading', () => (clearTimeout(t), resolve()));
  });
  w.loadURL(url).catch(() => {});
  await done;
  // Brightspace draws much of the page after it loads.
  await sleep(1200);
  return w;
}

/** On the class site (signed in), rather than on a sign-in page. */
function onSite(url) {
  const s = readSchool();
  const host = hostOf(url);
  return !!s.home && host === hostOf(s.home) && !/\/d2l\/login|\/login\b/i.test(url);
}

async function pageHasPassword(w) {
  return w.webContents.executeJavaScript(`!!document.querySelector('input[type=password]')`).catch(() => false);
}

/**
 * Make sure we're signed in: if a page sent us to sign in, Kea fills in the saved login (if the user let it).
 * Otherwise, or if that doesn't get back to the class site, Kea shows its window and waits for the user (up to
 * `waitMs`). Resolves true once back on the class site.
 */
async function ensureSignedIn(w, waitMs = 5 * 60000) {
  if (onSite(w.webContents.getURL()) && !(await pageHasPassword(w))) return true;
  const s = readSchool();
  // Kea's own sign-in, with the login the user chose to save (up to three steps: name, password, "stay signed in").
  if (s.login && hostOf(w.webContents.getURL()) === s.login.host) {
    for (let step = 0; step < 3 && !onSite(w.webContents.getURL()); step++) {
      const filled = await fillLogin(w, s.login);
      if (!filled) break;
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 15000);
        w.webContents.once('did-stop-loading', () => (clearTimeout(t), resolve()));
      });
      await sleep(1500);
    }
    if (onSite(w.webContents.getURL())) return true;
  }
  // The user signs in: show the window, and tell them why.
  w.setTitle('Kea needs you to sign in to your class site');
  w.show();
  w.focus();
  if (Notification.isSupported()) new Notification({ title: 'Kea needs you to sign in', body: 'Sign in to your class site in the Kea window so Kea can keep your classes up to date.' }).show();
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await sleep(1000);
    if (w.isDestroyed()) return false;
    if (onSite(w.webContents.getURL()) && !(await pageHasPassword(w))) {
      w.hide();
      return true;
    }
  }
  w.hide();
  return false;
}

/** Ask the window's preload to fill in the saved login (over Kea's private channel, out of the page's reach). */
function fillLogin(w, login) {
  return new Promise((resolve) => {
    const t = setTimeout(() => (ipcMain.removeListener('class-site:filled', on), resolve(false)), 5000);
    const on = (e, ok) => {
      if (e.sender !== w.webContents) return;
      clearTimeout(t);
      ipcMain.removeListener('class-site:filled', on);
      resolve(!!ok);
    };
    ipcMain.on('class-site:filled', on);
    w.webContents.send('class-site:fill', { user: login.user, pass: login.pass, userField: login.userField, passField: login.passField });
  });
}

// ---------- What the tools do ----------
/** Read a page: its title, address, text (including Brightspace's shadow DOM and same-site frames) and links. */
async function open(url, offset = 0) {
  const s = readSchool();
  if (!s.home) throw new Error('No class site is set up yet.');
  let w = await load(url || s.home);
  if (!(await ensureSignedIn(w))) throw new Error('Not signed in to the class site (the user did not finish signing in).');
  if (!onSite(w.webContents.getURL()) || (url && hostOf(w.webContents.getURL()) !== hostOf(url) && hostOf(url) === hostOf(s.home))) w = await load(url || s.home);
  const page = await w.webContents.executeJavaScript(`(${extract.toString()})()`);
  // Frames from the class site (the content viewer shows files and pages in iframes).
  for (const f of w.webContents.mainFrame.framesInSubtree) {
    if (f === w.webContents.mainFrame || hostOf(f.url) !== hostOf(s.home)) continue;
    try {
      const sub = await f.executeJavaScript(`(${extract.toString()})()`);
      if (sub.text.trim()) page.text += `\n\n[Frame: ${f.url}]\n${sub.text}`;
      page.links.push(...sub.links);
    } catch {}
  }
  const LIMIT = 40000;
  const text = page.text.slice(offset, offset + LIMIT);
  return {
    url: w.webContents.getURL(),
    title: page.title,
    text,
    more: page.text.length > offset + LIMIT ? `Text continues: call again with offset ${offset + LIMIT} (of ${page.text.length}).` : undefined,
    links: offset ? undefined : [...new Map(page.links.map((l) => [l.href, l])).values()].slice(0, 500)
  };
}

/** Runs inside the page: visible text and links, walking into shadow roots. */
function extract() {
  const out = [];
  const links = [];
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);
  const block = /^(P|DIV|LI|TR|H[1-6]|SECTION|ARTICLE|HEADER|FOOTER|TABLE|UL|OL|BR|D2L-.*)$/;
  const walk = (node) => {
    if (node.nodeType === 3) {
      const t = node.textContent.replace(/\s+/g, ' ');
      if (t.trim()) out.push(t);
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (node.nodeType === 1) {
      if (skip.has(node.tagName.toUpperCase())) return;
      const st = getComputedStyle(node);
      if (st.display === 'none' || st.visibility === 'hidden') return;
      if (node.tagName === 'A' && node.href) links.push({ text: (node.innerText || node.getAttribute('title') || node.getAttribute('aria-label') || '').trim().slice(0, 200), href: node.href });
      if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') return;
    }
    if (node.shadowRoot) walk(node.shadowRoot);
    for (const c of node.childNodes) walk(c);
    if (node.nodeType === 1 && block.test(node.tagName)) out.push('\n');
  };
  walk(document.body || document.documentElement);
  return { title: document.title, text: out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(), links };
}

/** A request with the class site's session (for its REST API and files). Signs in first when needed. */
async function request(url) {
  const s = readSchool();
  if (!s.home) throw new Error('No class site is set up yet.');
  if (hostOf(url) && hostOf(url) !== hostOf(s.home) && !/^https:\/\//i.test(url)) throw new Error('Only https addresses can be fetched.');
  const ses = session.fromPartition(partition());
  let res = await ses.fetch(url, { redirect: 'follow' });
  // Refused while signed in: a page students can't see, not a sign-in problem.
  if (res.status === 403 && (await status()).signedIn) return res;
  // Sent to sign in (or refused): sign in through the window, then try once more.
  if (res.status === 401 || res.status === 403 || (res.url && !onSite(res.url) && hostOf(url) === hostOf(s.home))) {
    const w = await load(s.home);
    if (!(await ensureSignedIn(w))) throw new Error('Not signed in to the class site (the user did not finish signing in).');
    res = await ses.fetch(url, { redirect: 'follow' });
  }
  return res;
}

async function fetchText(url, offset = 0) {
  const res = await request(url);
  const type = res.headers.get('content-type') || '';
  if (!/json|text|xml|html|javascript/i.test(type)) return { status: res.status, contentType: type, text: '', note: 'Not text: use d2l_download to save it.' };
  const body = await res.text();
  const LIMIT = 100000;
  return { status: res.status, url: res.url, contentType: type, text: body.slice(offset, offset + LIMIT), more: body.length > offset + LIMIT ? `Continues: call again with offset ${offset + LIMIT} (of ${body.length}).` : undefined };
}

/** Show a class-site page in Kea's own window, already signed in (for links the student opens). */
async function show(url) {
  const w = await load(url);
  w.setTitle('Kea: class site');
  w.show();
  w.focus();
  ensureSignedIn(w).then((ok) => ok && !onSite(w.webContents.getURL()) && w.loadURL(url).catch(() => {}));
  return true;
}

/**
 * Hand in a file: open the assignment folder's own D2L submission page in Kea's window and put the file in its upload
 * box, the same as the student choosing it there. Kea never presses Submit: the student checks the page and submits.
 * Returns { attached } (false when the page's upload box couldn't be found; the page is open either way).
 */
async function handIn(ou, folderId, file) {
  const s = readSchool();
  if (!s.home) throw new Error('No class site is set up yet.');
  if (!fs.existsSync(file)) throw new Error('Save the file first, then hand it in.');
  const url = new URL(`/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${encodeURIComponent(folderId)}&grpid=0&isprv=0&bp=0&ou=${encodeURIComponent(ou)}`, s.home).href;
  let w = await load(url);
  w.setTitle('Kea: hand in your work');
  w.show();
  w.focus();
  if (!(await ensureSignedIn(w))) return { attached: false };
  if (!onSite(w.webContents.getURL()) || !/folder_submit_files/i.test(w.webContents.getURL())) w = await load(url);
  const dbg = w.webContents.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach('1.3');
  } catch {
    return { attached: false };
  }
  // The upload box is a file input, sometimes only added after pressing "Add a File" or "Upload".
  const findInput = async () => {
    const doc = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
    const search = await dbg.sendCommand('DOM.performSearch', { query: 'input[type=file]', includeUserAgentShadowDOM: false });
    const found = search.resultCount ? await dbg.sendCommand('DOM.getSearchResults', { searchId: search.searchId, fromIndex: 0, toIndex: search.resultCount }) : { nodeIds: [] };
    await dbg.sendCommand('DOM.discardSearchResults', { searchId: search.searchId }).catch(() => {});
    return doc && found.nodeIds[0];
  };
  const pressAdd = () =>
    w.webContents
      .executeJavaScript(
        `(() => { const all = []; const walk = (r) => { for (const el of r.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document);
          const b = all.find((el) => /^(BUTTON|D2L-BUTTON|D2L-BUTTON-SUBTLE|A)$/.test(el.tagName) && /add a file|upload|choose file|browse/i.test((el.innerText || el.getAttribute('text') || el.getAttribute('aria-label') || '').trim()));
          if (b) { b.click(); return true; } return false; })()`
      )
      .catch(() => false);
  try {
    let node = await findInput();
    for (let i = 0; !node && i < 8; i++) {
      if (i === 0 || i === 4) await pressAdd();
      await sleep(1000);
      node = await findInput();
    }
    if (!node) return { attached: false };
    await dbg.sendCommand('DOM.setFileInputFiles', { files: [file], nodeId: node });
    return { attached: true };
  } catch {
    return { attached: false };
  } finally {
    try {
      dbg.detach();
    } catch {}
  }
}

/** Whether an address is on the class site (those open in Kea's signed-in window). */
const isClassSite = (url) => {
  const s = readSchool();
  return !!s.home && hostOf(url) === hostOf(s.home);
};

/** GET one of D2L's data addresses (relative to the class site) as JSON: { status, data }. For Kea's own pre-check. */
async function getJson(rel) {
  const s = readSchool();
  if (!s.home) throw new Error('No class site is set up yet.');
  const res = await request(new URL(rel, s.home).href);
  if (!res.ok) return { status: res.status, data: null };
  try {
    return { status: res.status, data: await res.json() };
  } catch {
    return { status: res.status, data: null };
  }
}

/** Save a file from the class site into the profile's workspace (only under data/downloads). */
async function download(url, rel) {
  const base = path.join(profiles.paths().workspace, 'data', 'downloads');
  const dest = path.resolve(base, String(rel || '').replace(/^[\\/]+/, ''));
  if (!dest.startsWith(path.resolve(base) + path.sep)) throw new Error('Files can only be saved under data/downloads.');
  const res = await request(url);
  if (!res.ok) throw new Error(`The class site answered ${res.status}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return { saved: path.relative(profiles.paths().workspace, dest), bytes: buf.length, contentType: res.headers.get('content-type') || '' };
}

async function status() {
  const s = readSchool();
  if (!s.home) return { setUp: false, signedIn: false };
  try {
    const ses = session.fromPartition(partition());
    const res = await ses.fetch(new URL('/d2l/api/lp/1.0/users/whoami', s.home).href, { redirect: 'manual' });
    return { setUp: true, signedIn: res.status === 200, home: s.home };
  } catch {
    return { setUp: true, signedIn: false, home: s.home };
  }
}

/**
 * The first sign-in: show the window at the class site and let the user sign in. With `remember`, the login form
 * they submit is saved (encrypted) so Kea can sign in for them later.
 */
async function signIn(remember) {
  const s = readSchool();
  if (!s.home) throw new Error('Enter your class site address first.');
  rememberNext = !!remember;
  s.remember = !!remember;
  writeSchool(s);
  const w = await load(s.home);
  const ok = await ensureSignedIn(w, 10 * 60000);
  rememberNext = false;
  return { signedIn: ok, ...schoolInfo() };
}

// The window's preload reports the login form the user submitted. It's kept only while they asked Kea to remember
// it, and only from Kea's own class-site window. A two-step login (name, then password) is put back together.
let rememberNext = false;
let pendingUser = null;
function onLoginSubmitted(e, form) {
  if (!wantsRemember() || !win || win.isDestroyed() || e.sender !== win.webContents || !form) return;
  const host = hostOf(form.url);
  if (!form.pass) {
    if (form.user) pendingUser = { host, user: String(form.user), userField: form.userField || '' };
    return;
  }
  const user = form.user ? { user: String(form.user), userField: form.userField || '' } : pendingUser?.host === host ? pendingUser : null;
  if (!user) return;
  const s = readSchool();
  // The same login reported twice (a click, then the page moving on): nothing new to save.
  if (s.login && s.login.host === host && s.login.user === user.user && s.login.pass === String(form.pass)) return;
  s.login = { host, user: user.user, pass: String(form.pass), userField: user.userField, passField: form.passField || '' };
  writeSchool(s);
  pendingUser = null;
}

const remembering = (e) => (e.returnValue = !!(wantsRemember() && win && !win.isDestroyed() && e.sender === win.webContents));

module.exports = { open, show, handIn, isClassSite, fetchText, getJson, download, status, signIn, schoolInfo, setHome, forgetLogin, onLoginSubmitted, remembering };

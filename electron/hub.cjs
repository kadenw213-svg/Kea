// The Kea Hub: one Kea account for Kea and KeaS (accounts, classes, study, storage), run by Kea's creator.
// Kea talks to it here, in the main process. The sign-in (a session token) is encrypted with the OS keychain and never
// shown to the page. The password is sent once, over the Hub's HTTPS tunnel, and never stored here.
//
// Settings: hub.url (where the Hub is), hub.googleClientId / hub.googleClientSecret (the Kea Google client used only
// for "Verify with Google": openid + email, nothing else).
const { app, ipcMain, shell, net, safeStorage } = require('electron');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const settings = require('./settings.cjs');

// Where Kea finds the Kea Hub unless the person sets another address (Settings → Kea account → Kea Hub address).
// This is the one place to change it: the Hub owner's public https://….ts.net address goes here for releases, so
// every device reaches it. 127.0.0.1 only works on the Hub's own PC.
const DEFAULT_HUB_URL = 'http://127.0.0.1:4860';
const hubUrl = () => String(settings.get('hub.url', '') || process.env.KEA_HUB_URL || DEFAULT_HUB_URL).replace(/\/+$/, '');
const tokenFile = () => path.join(app.getPath('userData'), 'hub-session.bin');
// What the rest of Kea needs to know without asking the Hub (school mode's verified check, the badge): no secrets.
const cacheFile = () => path.join(app.getPath('userData'), 'hub-account.json');

function readToken() {
  try {
    const raw = fs.readFileSync(tokenFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
  } catch {
    return null;
  }
}
function writeToken(t) {
  if (!t) return fs.rmSync(tokenFile(), { force: true });
  fs.writeFileSync(tokenFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(t) : Buffer.from(t));
}
function cached() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch {
    return null;
  }
}
function saveCache(me) {
  if (!me) return fs.rmSync(cacheFile(), { force: true });
  const a = me.account;
  // No account on this computer yet: the Hub account becomes it (school mode, the badge, the name Kea shows).
  const local = path.join(app.getPath('userData'), 'account.json');
  if (!fs.existsSync(local)) fs.writeFileSync(local, JSON.stringify({ email: a.email, name: a.displayName }, null, 1));
  fs.writeFileSync(cacheFile(), JSON.stringify({ id: a.id, email: a.email, name: a.displayName, emailVerified: a.emailVerified, verifiedBy: a.verifiedBy, owner: a.owner, canHost: a.canHost, identityVerified: a.identityVerified, totpEnabled: a.totpEnabled, leaderboard: a.leaderboard ?? null, supporter: a.supporter ?? null, progress: me.progress ?? null, terms: me.terms ?? null, at: Date.now() }, null, 1));
}

class HubError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function req(method, p, body, { auth = true } = {}) {
  const token = auth ? readToken() : null;
  let res;
  try {
    res = await net.fetch(hubUrl() + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-kea': '1', 'x-kea-client': `Kea/${app.getVersion()}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new HubError("Can't reach the Kea Hub right now. Check your internet, or try again in a bit (it may be updating).", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && auth && token && !data.totpRequired) {
    // The session ended (signed out elsewhere, password changed, suspended).
    writeToken(null);
    saveCache(null);
  }
  if (!res.ok) throw new HubError(data.error || `The Kea Hub said ${res.status}.`, res.status, data);
  return data;
}

/** After signing in: keep the token, refresh what Kea knows. */
async function signedIn(r) {
  writeToken(r.token);
  setTimeout(startSync, 1000);
  return refresh();
}
async function refresh() {
  if (!readToken()) return status();
  const me = await req('GET', '/v1/me');
  saveCache(me);
  // A newer notification than Kea has seen: fetch it now instead of at the next poll.
  if (!process.env.KEA_WORKER_JOB) require('./hubNotes.cjs').seen(me.notifications?.latest);
  return { ...base(), signedIn: true, reachable: true, me };
}
const base = () => ({ url: hubUrl(), defaultUrl: DEFAULT_HUB_URL, cached: cached() });
async function status() {
  if (!readToken()) {
    let reachable = false;
    try {
      await req('GET', '/v1/health', undefined, { auth: false });
      reachable = true;
    } catch {}
    return { ...base(), signedIn: false, reachable, me: null };
  }
  try {
    return await refresh();
  } catch (e) {
    // Offline: still signed in, working from what Kea last knew.
    if (e.status === 0) return { ...base(), signedIn: true, reachable: false, me: null };
    if (e.status === 401) return { ...base(), signedIn: false, reachable: true, me: null };
    throw e;
  }
}

// ---------- Verify with Google: a Google ID token from the desktop OAuth flow (openid + email only) ----------
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let pendingGoogle = null;
function googleIdToken(loginHint) {
  const id = String(settings.get('hub.googleClientId', '') || process.env.KEA_GOOGLE_CLIENT_ID || '').trim();
  const secret = String(settings.get('hub.googleClientSecret', '') || process.env.KEA_GOOGLE_CLIENT_SECRET || '').trim();
  if (!id) return Promise.reject(new HubError('Verify with Google isn’t set up in this copy of Kea yet.', 503));
  if (pendingGoogle) pendingGoogle.cancel();
  return new Promise((resolve, reject) => {
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const server = http.createServer(async (rq, rs) => {
      const url = new URL(rq.url, 'http://127.0.0.1');
      if (url.pathname !== '/') return rs.writeHead(404).end();
      const page = (ok, msg) => {
        rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        rs.end(`<!doctype html><meta charset="utf-8"><title>Kea</title><body style="font-family:Segoe UI,system-ui,sans-serif;background:#131314;color:#e3e3e3;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="font-weight:500">${ok ? 'Done' : 'That didn’t finish'}</h2><p style="color:#9aa0a6">${msg}</p></div></body>`);
      };
      if (url.searchParams.get('state') !== state) return page(false, 'Please try again from Kea.');
      const code = url.searchParams.get('code');
      if (!code) {
        page(false, 'You can close this tab.');
        return finish(new HubError('Google sign-in was cancelled.', 400));
      }
      try {
        const port = server.address().port;
        const r = await net.fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ code, client_id: id, ...(secret ? { client_secret: secret } : {}), code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: `http://127.0.0.1:${port}` }).toString(),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.id_token) throw new HubError(j.error_description || 'Google sign-in failed.', 400);
        page(true, 'You can close this tab and go back to Kea.');
        finish(null, j.id_token);
      } catch (err) {
        page(false, String(err.message || err));
        finish(err);
      }
    });
    const timer = setTimeout(() => finish(new HubError('Google sign-in timed out.', 408)), 5 * 60e3);
    const finish = (err, val) => {
      clearTimeout(timer);
      pendingGoogle = null;
      setTimeout(() => server.close(), 500);
      err ? reject(err) : resolve(val);
    };
    pendingGoogle = { cancel: () => finish(new HubError('Replaced by a newer sign-in.', 409)) };
    server.listen(0, '127.0.0.1', () => {
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: id,
        redirect_uri: `http://127.0.0.1:${server.address().port}`,
        response_type: 'code',
        scope: 'openid email profile',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
        state,
        ...(loginHint ? { login_hint: loginHint } : {}),
      }).toString();
      shell.openExternal(auth.toString());
    });
  });
}

// Errors reach the page as { error, status, data } so it can show the right screen (two-step code, terms, ...).
const wrap = (fn) => async (_e, arg) => {
  try {
    return { ok: true, value: await fn(arg || {}) };
  } catch (e) {
    return { ok: false, error: String(e.message || e), status: e.status ?? null, data: e.data ?? null };
  }
};

// ---------- Kea's shared Claude: asking for a scan, and answering the worker's relayed calls ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Write a file into this account's Kea storage (raw bytes). */
async function putFile(p, data) {
  const r = await net.fetch(`${hubUrl()}/v1/files/${p.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', headers: { authorization: `Bearer ${readToken()}`, 'x-kea': '1', 'x-kea-client': `Kea/${app.getVersion()}` }, body: data });
  if (!r.ok) throw new HubError((await r.json().catch(() => ({}))).error || `The Kea Hub said ${r.status}.`, r.status);
}
/**
 * Ask Kea's shared Claude to set up all this profile's classes. Only the class site's address and the profile's name
 * are sent, never the login: the scan browses through this Kea while it runs (answerCalls).
 */
async function requestScan() {
  const browser = require('./scholar/browser.cjs');
  const profiles = require('./scholar/profiles.cjs');
  const info = browser.schoolInfo();
  if (!info.home) throw new HubError('Set up your class site first (Add a class → From your school), then sign in to it.', 400);
  const me = cached();
  if (!me) throw new HubError('Sign in to your Kea account first.', 401);
  const profile = profiles.all().list.find((p) => p.id === profiles.active())?.name || 'School';
  const course = { school: info.host, code: 'all-classes', term: new Date().toISOString().slice(0, 7), section: me.id };
  const r = await req('POST', '/v1/scan', { kind: 'initial_scan', course, ...targetArg() });
  if (r.status === 'queued' && r.uploadTo) {
    await putFile(`${r.uploadTo}job.json`, JSON.stringify({ home: info.home, platform: info.platform, profile }));
    await req('POST', `/v1/scan/${r.job.id}/ready`, {});
  }
  if (r.job?.id) myJobs.add(r.job.id, r.job.kind || 'initial_scan');
  watchJobs();
  return r;
}
/**
 * Where course material for this profile goes in this account's Kea storage ("kea/Kea/<profile>/"): the folder this
 * Kea syncs through the Hub. Only when this Kea syncs through the Hub.
 */
function targetArg() {
  try {
    const cloud = require('./scholar/cloud.cjs');
    const t = cloud.drive()?.id === 'kea-hub' ? cloud.target() : null;
    if (!t) return {};
    const rel = path.relative(syncRoot(), t);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return {};
    return { target: `${require('./scholar/hubsync.cjs').toRemote(rel)}/` };
  } catch {
    return {};
  }
}
/** Chapters this profile can ask Kea's shared Claude for more questions on: [{ courseId, code, name, label, test }]. */
async function questionChapters() {
  const db = require('./scholar/db.cjs');
  const profiles = require('./scholar/profiles.cjs');
  const P = profiles.paths();
  const courses = new Map((await db.courses(P.db, P.textbooks, {}).catch(() => [])).map((c) => [c.id, c]));
  return (await db.textbookChapters(P.db, P.textbooks).catch(() => []))
    .filter((x) => courses.has(x.courseId))
    .map((x) => ({ courseId: x.courseId, code: courses.get(x.courseId).code, name: courses.get(x.courseId).name, label: x.label, test: x.test || null }));
}
/**
 * Ask Kea's shared Claude for one batch of new practice questions on a chapter. Classmates (same school, course and
 * term) who ask for the same chapter share the batch. The questions arrive with a later sync (sharedMaterial.cjs).
 */
async function requestQuestions({ courseId, chapter, joinCode }) {
  const me = cached();
  if (!me) throw new HubError('Sign in to your Kea account first.', 401);
  const c = (await questionChapters()).find((x) => x.courseId === courseId && x.label === chapter);
  if (!c) throw new HubError('Pick a chapter that has a textbook in Kea.', 400);
  const browser = require('./scholar/browser.cjs');
  const host = browser.schoolInfo().host;
  if (!host) throw new HubError('Set up your class site first (Add a class → From your school).', 400);
  const t = targetArg();
  if (!t.target) throw new HubError('Kea has to sync through your Kea account for this (Settings → Sync: Kea Hub).', 400);
  const profiles = require('./scholar/profiles.cjs');
  const db = require('./scholar/db.cjs');
  const P = profiles.paths();
  const term = (await db.courses(P.db, P.textbooks, {}).catch(() => [])).find((x) => x.id === courseId)?.term || '';
  const profile = profiles.all().list.find((p) => p.id === profiles.active())?.name || 'School';
  const r = await req('POST', '/v1/scan', {
    kind: 'more_questions',
    course: { school: host, code: c.code, term: term || 'current' },
    chapter,
    ...t,
    detail: { courseCode: c.code, chapter, profile },
    ...(joinCode ? { joinCode: String(joinCode).trim() } : {}),
  });
  if (r.job?.id) myJobs.add(r.job.id, r.job.kind || 'more_questions');
  watchJobs();
  return r;
}
/** The Hub's course section for one of this profile's courses (as requestQuestions names it). */
async function sectionOf(courseId) {
  const c = (await questionChapters()).find((x) => x.courseId === courseId);
  if (!c) throw new HubError('Pick a course that has a textbook in Kea.', 400);
  const host = require('./scholar/browser.cjs').schoolInfo().host;
  if (!host) throw new HubError('Set up your class site first (Add a class → From your school).', 400);
  const profiles = require('./scholar/profiles.cjs');
  const db = require('./scholar/db.cjs');
  const P = profiles.paths();
  const term = (await db.courses(P.db, P.textbooks, {}).catch(() => [])).find((x) => x.id === courseId)?.term || '';
  return { school: host, code: c.code, term: term || 'current' };
}

// While one of this person's jobs runs, the worker's calls come here and are answered with this Kea's own signed-in
// browser, limited to the class site and the platforms it links to (mcp.cjs allowedUrl), and read-only. Only for a job
// THIS device asked for (myJobs: never one the Hub merely says is running), only the operations that kind of job needs,
// and only for a limited time; a notification and the shared-Claude panel say while it's happening.
const RELAY_OPS = { initial_scan: ['request', 'open', 'click', 'status'], update_scan: ['request', 'open', 'click', 'status'] };
const relayMinutes = () => Math.max(10, Math.min(480, Number(settings.get('hub.relayMinutes', 60)) || 60));
/** The shared-Claude jobs this device asked for (userData/hub-my-jobs.json): { [id]: { kind, at, servedFrom } }. */
const myJobs = {
  file: () => path.join(app.getPath('userData'), 'hub-my-jobs.json'),
  read() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
      return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    } catch {
      return {};
    }
  },
  write(all) {
    // (Jobs from more than 30 days ago are forgotten.)
    const keep = Object.fromEntries(Object.entries(all).filter(([, v]) => Date.now() - (v.at || 0) < 30 * 864e5));
    fs.writeFileSync(this.file(), JSON.stringify(keep));
  },
  add(id, kind) {
    const all = this.read();
    if (!all[id]) all[id] = { kind, at: Date.now() };
    this.write(all);
  },
  get(id) {
    return this.read()[id] || null;
  },
  /** When this device first served the job's calls (kept, so a restart doesn't start the time limit over). */
  servedFrom(id) {
    const all = this.read();
    if (!all[id]) return null;
    if (!all[id].servedFrom) (all[id].servedFrom = Date.now()), this.write(all);
    return all[id].servedFrom;
  },
};
async function relayOp(op, a, kind = 'initial_scan') {
  if (!(RELAY_OPS[kind] || []).includes(op)) throw new Error(`Not allowed: ${op}`);
  const browser = require('./scholar/browser.cjs');
  const { allowedUrl } = require('./scholar/mcp.cjs');
  const allowed = (u) => {
    try {
      return !!allowedUrl(u);
    } catch {
      return false;
    }
  };
  switch (op) {
    case 'request': {
      const res = await browser.request(allowedUrl(a.url));
      // (Where it ended up after redirects must be allowed too: an open redirect on an allowed site never carries
      // this person's signed-in page to another host.)
      if (res.url && !allowed(res.url)) throw new Error('That page redirects to a site Kea doesn’t read for the scan.');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 30 * 1024 * 1024) throw new Error('That file is over 30 MB.');
      return { status: res.status, url: res.url, headers: { 'content-type': res.headers.get('content-type') || '', link: res.headers.get('link') || '' }, body64: buf.toString('base64') };
    }
    case 'open':
      return browser.open(allowedUrl(a.url), Number(a.offset) || 0);
    case 'click':
      return browser.click(String(a.text || '').slice(0, 120), Number(a.nth) || 1, allowed);
    case 'status':
      return browser.status();
    default:
      throw new Error(`Not allowed: ${op}`);
  }
}
/** Jobs being served now: { id, since, until, calls } (for the shared-Claude panel). */
const serving = new Map();
function servingNow() {
  return [...serving.values()].map((x) => ({ ...x }));
}
async function answerCalls(jobId, kind) {
  if (serving.has(jobId)) return;
  const mine = myJobs.get(jobId);
  // A job this device never asked for, or a kind that needs no class site: never served.
  if (!mine || !RELAY_OPS[kind] || (mine.kind && mine.kind !== kind)) return;
  const since = myJobs.servedFrom(jobId);
  const until = since + relayMinutes() * 60e3;
  if (Date.now() >= until) return;
  const state = { id: jobId, kind, since, until, calls: 0 };
  serving.set(jobId, state);
  let note = null;
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) {
      note = new Notification({ title: 'Kea’s shared Claude is reading your class site', body: 'Your scan is running and reads your class site through this Kea, read-only. Keep Kea open until it finishes.', silent: true });
      note.show();
    }
  } catch {}
  try {
    for (;;) {
      if (Date.now() >= until) break; // its time is up: the worker's calls go unanswered and the job ends
      let r;
      try {
        r = await req('GET', `/v1/scan/${jobId}/calls`);
      } catch (e) {
        if (e.status === 404 || e.status === 401 || e.status === 403 || e.status === 428) break; // finished, or not ours
        await sleep(5000);
        continue;
      }
      for (const c of r.calls || []) {
        let body;
        if (Date.now() >= until) body = { ok: false, error: 'This Kea stopped answering: the scan reached its time limit.' };
        else
          try {
            state.calls++;
            body = { ok: true, result: await relayOp(c.op, c.args || {}, kind) };
          } catch (e) {
            body = { ok: false, error: String(e.message || e) };
          }
        await req('POST', `/v1/scan/${jobId}/calls/${c.id}/result`, body).catch(() => {});
      }
    }
  } finally {
    serving.delete(jobId);
    try {
      note?.close();
    } catch {}
  }
}
let jobsTimer = null;
const jobsState = { jobs: [], allowance: null, at: 0 };
/** Checks this person's queued jobs (every 20 s while some are waiting, else every 3 minutes) and serves running ones. */
function watchJobs(delay = 1000) {
  clearTimeout(jobsTimer);
  jobsTimer = setTimeout(async () => {
    let busy = false;
    if (isSignedIn()) {
      try {
        const r = await req('GET', '/v1/scan');
        Object.assign(jobsState, { jobs: r.jobs, allowance: r.allowance, at: Date.now() });
        // (Only this device's own scan jobs: answerCalls checks.)
        for (const j of r.jobs) if (j.status === 'running' && RELAY_OPS[j.kind]) answerCalls(j.id, j.kind);
        busy = r.jobs.some((j) => j.status === 'queued' || j.status === 'running');
      } catch {}
    }
    watchJobs(busy ? 20_000 : 180_000);
  }, delay);
}

// ---------- The owner's launcher: runs queued jobs in a hidden worker copy of Kea (scholar/worker.cjs) ----------
// Only on the Hub owner's PC (the owner key from KeaS's setup is there), only when this Kea isn't scanning its own
// classes (the owner's scans come first), one job at a time.
function ownerKeyFile() {
  const set = String(settings.get('hub.ownerKeyFile', '') || '');
  if (set && fs.existsSync(set)) return set;
  try {
    const c = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'KeaS', 'keas-config.json'), 'utf8'));
    const f = c.dataDir && path.join(c.dataDir.replace(/\\\\/g, '\\'), 'owner.key');
    return f && fs.existsSync(f) ? f : null;
  } catch {
    return null;
  }
}
let workerProc = null;
const workerState = { running: null, last: null };
const workersDir = () => path.join(app.getPath('userData'), 'workers');
/** The longest a shared-Claude job may take, in minutes (Settings → Kea's shared Claude). */
const workerMinutes = () => Math.max(10, Math.min(240, Number(settings.get('hub.workerMinutes', 45)) || 45));
/**
 * A finished job's folder (that student's class database, downloads, logs and Claude's transcript) is deleted; only a
 * few lines about it stay, in workers/summary.log.
 */
async function endWorkerFolder(dir, line) {
  let tail = [];
  try {
    tail = fs.readFileSync(path.join(dir, 'worker.log'), 'utf8').trim().split(/\r?\n/).slice(-3).map((l) => l.slice(0, 300));
  } catch {}
  try {
    fs.mkdirSync(workersDir(), { recursive: true });
    const log = path.join(workersDir(), 'summary.log');
    const old = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).slice(-1000) : [];
    fs.writeFileSync(log, [...old, line, ...tail.map((l) => `    ${l}`)].join('\n') + '\n');
  } catch (e) {
    console.error('Worker summary', e.message);
  }
  // (Windows can hold a file for a moment after the program using it ends.)
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return true;
    } catch {}
    await sleep(1000 * (i + 1));
  }
  console.error('Couldn’t delete the worker folder', dir);
  return false;
}
/** Worker folders left from a job that didn't end cleanly (Kea closed or crashed mid-job). */
async function sweepWorkerFolders() {
  let entries = [];
  try {
    entries = fs.readdirSync(workersDir(), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) await endWorkerFolder(path.join(workersDir(), e.name), `${new Date().toISOString()} job ${e.name}: left over from an earlier start, deleted`);
}
async function launcherTick() {
  if (workerProc || process.env.KEA_WORKER_JOB) return;
  if (!cached()?.owner) return;
  const keyFile = ownerKeyFile();
  if (!keyFile) return;
  try {
    const s = require('./scholar/runner.cjs').status();
    if (s.running || s.queued.length) return;
  } catch {
    return;
  }
  await sweepWorkerFolders();
  if (workerProc) return;
  const port = Number(settings.get('hub.ownerPort', 4861)) || 4861;
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  const call = (p, body) => net.fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'x-kea-owner-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  let job;
  try {
    job = (await call('/owner/scan/next')).job;
  } catch {
    return; // the Hub isn't running here
  }
  if (!job) return;
  const task = { initial_scan: 'import', update_scan: 'sync', more_questions: 'more_questions' }[job.kind];
  if (!task) return void call(`/owner/scan/${job.id}/finish`, { ok: false, note: `Kea can't run "${job.kind}" jobs yet.` });
  // (The Hub makes job ids; one that isn't a plain name never becomes a folder.)
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(job.id))) return void call(`/owner/scan/${encodeURIComponent(job.id)}/finish`, { ok: false, note: 'Bad job id.' });
  const dir = path.join(workersDir(), job.id);
  const { spawn } = require('child_process');
  const { killTree } = require('./scholar/procTree.cjs');
  const { minimalEnv } = require('./scholar/workspace.cjs');
  const limitMs = workerMinutes() * 60e3;
  const startedAt = Date.now();
  workerState.running = { id: job.id, kind: job.kind, startedAt };
  // The worker copy gets only what it needs: no tokens or keys from this Kea's environment (the owner key is a file
  // path it reads; Claude's own runs get even less, see workspace.cjs).
  const env = { ...minimalEnv(), KEA_WORKER_JOB: job.id, KEA_WORKER_TASK: task, KEA_USERDATA: dir, KEA_OWNER_KEY_FILE: keyFile, KEA_HUB_OWNER_PORT: String(port), KEA_WORKER_LIMIT_MS: String(limitMs), ...(process.env.KEA_DRY_RUN && !app.isPackaged ? { KEA_DRY_RUN: process.env.KEA_DRY_RUN } : {}) };
  const proc = spawn(process.execPath, app.isPackaged ? [] : [app.getAppPath()], { env, stdio: 'ignore', windowsHide: true });
  workerProc = proc;
  let killedForTime = false;
  // The worker ends Claude at its own limit; if the worker itself is still there a few minutes later, it and
  // everything under it (Claude, Bash, uv, Python) are ended here.
  const backstop = setTimeout(() => {
    killedForTime = true;
    killTree(proc.pid).catch(() => {});
  }, limitMs + 5 * 60e3);
  proc.on('exit', async (code) => {
    clearTimeout(backstop);
    workerProc = null;
    workerState.last = { id: job.id, code, at: Date.now() };
    workerState.running = null;
    // A worker that crashed (or was ended) before reporting: mark the job failed so the queue moves on.
    if (code !== 0) await call(`/owner/scan/${job.id}/finish`, { ok: false, note: killedForTime ? 'The job ran over its time limit.' : `The worker stopped (code ${code}).` }).catch(() => {});
    const mins = Math.round((Date.now() - startedAt) / 60e3);
    await endWorkerFolder(dir, `${new Date().toISOString()} job ${job.id} ${job.kind}: ${code === 0 ? 'done' : killedForTime ? 'ended at the time limit' : `ended (code ${code})`} after ${mins} min`);
  });
}

// ---------- Sync through the Hub (scholar/hubsync.cjs): the "Kea Hub" drive's folder, mirrored both ways ----------
const isSignedIn = () => !!readToken();
const syncRoot = () => path.join(app.getPath('userData'), 'hub-sync');
let syncer = null, syncTimer = null, watcher = null, debounce = null, lastDown = 0, materialChecked = false;
const syncState = { on: false, last: null, error: null, counts: null };
function syncNow() {
  if (!syncer || !isSignedIn()) return Promise.resolve(null);
  return syncer
    .cycle()
    .then((c) => {
      Object.assign(syncState, { last: Date.now(), error: null, offline: false, counts: c });
      // Course material from Kea's shared Claude that came down (or is still waiting for its class): take it in.
      if (c.down > lastDown || !materialChecked) {
        materialChecked = true;
        require('./scholar/sharedMaterial.cjs').run().catch((e) => console.error('Shared material', e.message));
      }
      lastDown = c.down;
      return syncState;
    })
    .catch((e) => {
      syncState.error = e.message;
      syncState.offline = !e.status; // (Kea Cloud shows "offline" rather than an error)
      // Signed out elsewhere, or new terms to agree to: stop until that's sorted (status() and the terms gate show it).
      if (e.status === 401 || e.status === 428) stopSync();
    });
}
function startSync() {
  let cloud;
  try {
    cloud = require('./scholar/cloud.cjs');
  } catch {
    return;
  }
  // Kea Cloud (keaCloud.cjs): documents sync whenever the person is signed in, even when Scholar uses another drive.
  const want = isSignedIn() && (cloud.drive()?.id === 'kea-hub' || require('./keaCloud.cjs').enabled());
  if (!want) return stopSync();
  if (syncer) return;
  const { createSync, httpClient } = require('./scholar/hubsync.cjs');
  fs.mkdirSync(syncRoot(), { recursive: true });
  syncer = createSync({
    root: syncRoot(),
    stateFile: path.join(app.getPath('userData'), 'hub-sync-state.json'),
    client: httpClient({ base: hubUrl, token: readToken, fetchFn: net.fetch, client: `Kea/${app.getVersion()}` }),
    log: (m) => console.log(m),
    ...require('./keaCloud.cjs').syncOptions(() => cloud.drive()?.id === 'kea-hub'),
  });
  syncState.on = true;
  // Others' changes every 15 s (a tiny "what changed" request); this device's changes 2 s after they happen.
  syncTimer = setInterval(syncNow, 15_000);
  try {
    watcher = fs.watch(syncRoot(), { recursive: true }, () => {
      clearTimeout(debounce);
      debounce = setTimeout(syncNow, 2000);
    });
  } catch {}
  syncNow();
}
function stopSync() {
  clearInterval(syncTimer);
  clearTimeout(debounce);
  try {
    watcher?.close();
  } catch {}
  syncer = syncTimer = watcher = null;
  syncState.on = false;
}

function register() {
  ipcMain.handle('hub:requestScan', wrap(() => requestScan()));
  ipcMain.handle('hub:questionChapters', wrap(() => questionChapters()));
  ipcMain.handle('hub:requestQuestions', wrap((a) => requestQuestions(a)));
  // Getting into a course section someone else started: requests to let in (or my own), and the section's code.
  ipcMain.handle('hub:sectionRequests', wrap(() => (isSignedIn() ? req('GET', '/v1/course-sections/requests') : { incoming: [], mine: [] })));
  ipcMain.handle('hub:sectionDecide', wrap((a) => req('POST', `/v1/course-sections/requests/${encodeURIComponent(String(a.id))}/decide`, { approve: a.approve === true })));
  ipcMain.handle('hub:sectionCode', wrap(async (a) => req('POST', '/v1/course-sections/code', { course: await sectionOf(a.courseId), ...(a.reset ? { reset: true } : {}) })));
  ipcMain.handle('hub:scanJobs', wrap(async () => (isSignedIn() ? { ...(await req('GET', '/v1/scan')), worker: workerState, serving: servingNow() } : { jobs: [], allowance: null, worker: workerState, serving: servingNow() })));
  // A worker copy (scholar/worker.cjs) does none of the background work below.
  if (process.env.KEA_WORKER_JOB) return;
  // Start (or stop) syncing through the Hub when Kea starts, and whenever sign-in or the chosen drive may have changed.
  setTimeout(startSync, 5000);
  setInterval(startSync, 60_000);
  // This person's shared-Claude jobs (answering a running one's calls), and on the owner's PC, the launcher.
  watchJobs(8000);
  setInterval(launcherTick, 60_000);
  ipcMain.handle('hub:syncStatus', wrap(() => ({ ...syncState })));
  ipcMain.handle('hub:syncNow', wrap(async () => (startSync(), await syncNow(), { ...syncState })));
  ipcMain.handle('hub:status', wrap(() => status()));
  ipcMain.handle('hub:terms', wrap(() => req('GET', '/v1/terms', undefined, { auth: false })));
  ipcMain.handle('hub:support', wrap(() => req('GET', '/v1/support', undefined, { auth: false })));
  ipcMain.handle('hub:openSupport', wrap(async () => {
    const s = await req('GET', '/v1/support', undefined, { auth: false });
    if (s.url && /^https:\/\//.test(s.url)) await shell.openExternal(s.url);
    return true;
  }));
  ipcMain.handle('hub:changes', wrap(() => req('GET', '/v1/terms/changes')));
  ipcMain.handle('hub:openTerms', wrap(({ since }) => shell.openExternal(`${hubUrl()}/terms${since ? `?since=${Number(since)}` : ''}`)));
  ipcMain.handle('hub:register', wrap(async (a) => {
    await req('POST', '/v1/auth/register', { email: a.email, password: a.password, displayName: a.name, age13: a.age13 === true, ...(a.birthYear ? { birthYear: Number(a.birthYear) } : {}), termsVersion: a.termsVersion, termsSections: a.termsSections }, { auth: false });
    // The Hub answers the same whether or not the email already had an account (so nobody can use it to find out who
    // has one), and never signs in by itself: sign in now with what was just entered.
    try {
      return await signedIn(await req('POST', '/v1/auth/login', { email: a.email, password: a.password }, { auth: false }));
    } catch (e) {
      if (e.status === 401 || e.status === 429) throw new HubError('This email may already have a Kea account. Sign in instead, or use Forgot password.', 409, { exists: true });
      throw e;
    }
  }));
  // Under 18: the birth year, and a parent's or guardian's sign-off before Kea's shared Claude.
  ipcMain.handle('hub:birthYear', wrap(async (a) => (await req('POST', '/v1/me/birth-year', { birthYear: Number(a.birthYear) }), refresh())));
  ipcMain.handle('hub:consent', wrap(() => req('GET', '/v1/me/consent')));
  // The optional phone number and who sees it (classmates, coworkers, both, nobody).
  ipcMain.handle('hub:setPhone', wrap(async (a) => {
    const body = {};
    if ('phone' in a) body.phone = a.phone == null || a.phone === '' ? null : String(a.phone);
    if (a.visibility) body.visibility = a.visibility;
    await req('POST', '/v1/me/phone', body);
    return refresh();
  }));
  ipcMain.handle('hub:consentRequest', wrap((a) => req('POST', '/v1/me/consent', { parentEmail: a.parentEmail })));
  ipcMain.handle('hub:consentGoogle', wrap(async () => {
    const c = await req('GET', '/v1/me/consent');
    if (c.parentSignOff !== 'pending' || !c.parentEmail) throw new HubError('Enter your parent’s or guardian’s email first.', 400);
    await req('POST', '/v1/me/consent/google', { idToken: await googleIdToken(c.parentEmail) });
    return refresh();
  }));
  ipcMain.handle('hub:login', wrap(async (a) => signedIn(await req('POST', '/v1/auth/login', { email: a.email, password: a.password, code: a.code || undefined }, { auth: false }))));
  ipcMain.handle('hub:accept', wrap(async (a) => (await req('POST', '/v1/terms/accept', { termsVersion: a.termsVersion, termsSections: a.termsSections }), refresh())));
  ipcMain.handle('hub:googleVerify', wrap(async () => (await req('POST', '/v1/me/verify/google', { idToken: await googleIdToken(cached()?.email) }), refresh())));
  ipcMain.handle('hub:googleSignIn', wrap(async (a) => signedIn(await req('POST', '/v1/auth/google', { idToken: await googleIdToken(a.email), code: a.code || undefined }, { auth: false }))));
  ipcMain.handle('hub:googleReset', wrap(async (a) => signedIn(await req('POST', '/v1/auth/reset/google', { idToken: await googleIdToken(a.email), password: a.password, code: a.code || undefined }, { auth: false }))));
  ipcMain.handle('hub:totpSetup', wrap(() => req('POST', '/v1/me/totp/setup', {})));
  ipcMain.handle('hub:totpEnable', wrap(async (a) => (await req('POST', '/v1/me/totp/enable', { code: a.code }), refresh())));
  ipcMain.handle('hub:logout', wrap(async () => {
    try {
      await req('POST', '/v1/auth/logout', {});
    } catch {}
    writeToken(null);
    saveCache(null);
    stopSync();
    return status();
  }));
  ipcMain.handle('hub:setUrl', wrap(async ({ url }) => {
    // Empty: back to the address this copy of Kea came with.
    if (!String(url || '').trim()) return settings.set({ 'hub.url': null }), status();
    let u;
    try {
      u = new URL(/^[a-z]+:\/\//i.test(String(url).trim()) ? String(url).trim() : `https://${String(url).trim()}`);
    } catch {
      throw new HubError('That isn’t a web address. It looks like https://name.tailnet.ts.net', 400);
    }
    if (!/^https?:$/.test(u.protocol)) throw new HubError('Use an https:// address.', 400);
    // Plain http only to this computer itself: anywhere else, someone on the network could pose as the Hub.
    if (u.protocol === 'http:' && !/^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i.test(u.hostname)) throw new HubError('Use the Hub’s https:// address (it looks like https://name.tailnet.ts.net). Plain http only works for a Hub on this computer.', 400);
    settings.set({ 'hub.url': u.origin });
    return status();
  }));
  // Hub classes, study sets, leaderboards and class sessions on the calendar.
  require('./hubClasses.cjs').register();
  // Notifications for this account (a list in the account panel, and Windows notifications).
  require('./hubNotes.cjs').register();
}

module.exports = { _relay: { relayOp, answerCalls, myJobs, servingNow, RELAY_OPS, endWorkerFolder }, register, cached, req, signedIn: isSignedIn, syncRoot, syncNow, url: hubUrl, refreshStatus: status, DEFAULT_HUB_URL, syncState: () => ({ ...syncState }), startSync };

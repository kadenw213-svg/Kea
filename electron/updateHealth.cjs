// Whether Kea is staying up to date, so it never goes stale without saying so (src/lib/updateState.ts shows it):
//   - its own update checks: when the last one was tried and when one last worked, how many failed in a row and why,
//     and since when a downloaded update has been waiting to install;
//   - what the servers say (docs/protocol.md section 0): the newest Kea they know of (so "Update available" shows even
//     when GitHub can't be reached from here), and a server that turned this Kea away as too old (426).
// Kept in update-health.json in Kea's profile folder, so failures that span restarts still add up. Electron-free (the
// tests drive it with their own clock and folder).
const fs = require('fs');
const path = require('path');

const EMPTY = { lastCheckAt: null, lastOkAt: null, failures: 0, lastError: null, available: null, downloaded: null, latest: {}, tooOld: {} };

/** "0.85.0" newer than "0.84.9"? Unreadable versions are never newer. */
function newer(a, b) {
  const p = (v) => (/^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')) || []).slice(1).map(Number);
  const x = p(a), y = p(b);
  if (x.length !== 3) return false;
  if (y.length !== 3) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * file: where it's kept; version: this Kea's version; onChange(snapshot) after every change.
 * Sources are 'account' (the Kea account server) and 'org:<server id>' (a KeaS server).
 */
function createUpdateHealth({ file, version = () => '0.0.0', now = () => Date.now(), onChange = () => {} } = {}) {
  let st = null;
  const load = () => {
    if (st) return st;
    try {
      st = { ...EMPTY, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      st = { ...EMPTY, latest: {}, tooOld: {} };
    }
    return st;
  };
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(st));
    } catch {}
    try {
      onChange(snapshot());
    } catch {}
  };
  const ver = () => String(typeof version === 'function' ? version() : version);

  /** What the page needs: the times and failures, the newest Kea a server knows of (only when newer), and a refusal. */
  function snapshot() {
    const s = load();
    const v = ver();
    // A downloaded update that's this version or older has been installed.
    const downloaded = s.downloaded && newer(s.downloaded.version, v) ? s.downloaded : null;
    const available = s.available && newer(s.available.version, v) ? s.available : null;
    let latest = null;
    for (const [from, x] of Object.entries(s.latest || {})) if (x?.version && newer(x.version, v) && (!latest || newer(x.version, latest.version))) latest = { version: x.version, from, at: x.at };
    // (A refusal from an older version of Kea is over once Kea updated past it.)
    // (The Kea account server's refusal comes first: it's the one that stops the most.)
    const refusals = Object.entries(s.tooOld || {}).filter(([, x]) => x && (!x.minVersion || newer(x.minVersion, v))).map(([from, x]) => ({ ...x, from }));
    const tooOld = refusals.find((x) => x.from === 'account') || refusals[0] || null;
    return { version: v, lastCheckAt: s.lastCheckAt, lastOkAt: s.lastOkAt, failures: s.failures, lastError: s.lastError, available, downloaded, latest, tooOld };
  }

  return {
    get: snapshot,
    /** Kea's own check started. */
    checking() {
      load().lastCheckAt = now();
      save();
    },
    /** It answered (newest, or a newer version found): the failures are over. */
    ok() {
      const s = load();
      s.lastOkAt = s.lastCheckAt = now();
      s.failures = 0;
      s.lastError = null;
      save();
    },
    /** The check found a newer version: since when it's been out (kept for the same version). */
    found(v) {
      const s = load();
      s.lastOkAt = s.lastCheckAt = now();
      s.failures = 0;
      s.lastError = null;
      if (s.available?.version !== v) s.available = { version: String(v), at: now() };
      save();
    },
    /** It failed (offline, GitHub down, a broken feed): one more in a row. */
    failed(message) {
      const s = load();
      s.lastCheckAt = now();
      s.failures = (s.failures || 0) + 1;
      s.lastError = String(message || 'The update check failed.').slice(0, 300);
      save();
    },
    /** An update finished downloading: since when it's been waiting (kept for the same version). */
    downloaded(v) {
      const s = load();
      if (s.downloaded?.version !== v) s.downloaded = { version: String(v), at: now() };
      save();
    },
    /** A server's /v1/health: the newest Kea it knows of (docs/protocol.md section 0). Older servers don't say. */
    serverSays(from, health) {
      const v = health?.latest?.kea;
      if (typeof v !== 'string' || !/^v?\d+\.\d+\.\d+/.test(v)) return;
      const s = load();
      if (s.latest?.[from]?.version === v) return;
      s.latest = { ...(s.latest || {}), [from]: { version: v.replace(/^v/, ''), at: now() } };
      save();
    },
    /** A server answered 426: this Kea is too old for it. `body`: { error, minVersion, updateUrl }. */
    tooOld(from, body) {
      const s = load();
      const x = { error: String(body?.error || 'Update Kea to keep using your Kea account.').slice(0, 300), minVersion: typeof body?.minVersion === 'string' ? body.minVersion : null, updateUrl: typeof body?.updateUrl === 'string' ? body.updateUrl : null, at: now() };
      if (s.tooOld?.[from]?.error === x.error && s.tooOld?.[from]?.minVersion === x.minVersion) return;
      s.tooOld = { ...(s.tooOld || {}), [from]: x };
      save();
    },
    /** A server answered normally again (its minimum went down, or Kea updated): its refusal is over. */
    served(from) {
      const s = load();
      if (!s.tooOld?.[from]) return;
      const { [from]: _gone, ...rest } = s.tooOld;
      s.tooOld = rest;
      save();
    },
  };
}

// The one Kea uses (made on first use, in Kea's profile folder; tests make their own).
let shared = null;
const listeners = new Set();
function health() {
  if (shared) return shared;
  const { app } = require('electron');
  shared = createUpdateHealth({ file: path.join(app.getPath('userData'), 'update-health.json'), version: () => app.getVersion(), onChange: (s) => listeners.forEach((f) => f(s)) });
  return shared;
}
/** Called with the new snapshot after every change (main.cjs sends it to the window). */
health.onChange = (f) => (listeners.add(f), () => listeners.delete(f));

module.exports = { createUpdateHealth, health, newer };

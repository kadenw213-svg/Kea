// The Google and Microsoft OAuth clients this copy of Kea signs in with: "Sign in with Google / Microsoft" for the Kea
// account, and Google Drive (Docs, Sheets and Slides) with the same Google client.
//
// Where each comes from, first found wins:
//   1. settings.json: hub.googleClientId, hub.googleClientSecret, hub.microsoftClientId (protected: only set by hand,
//      never from the page);
//   2. the environment: KEA_GOOGLE_CLIENT_ID, KEA_GOOGLE_CLIENT_SECRET, KEA_MICROSOFT_CLIENT_ID;
//   3. electron/buildConfig.json, written at build time by scripts/oauth-clients.cjs from the owner's file outside the
//      repo (git-ignored, never committed). A Google "Desktop app" client's secret isn't confidential for installed
//      apps, but it still stays out of this public repo.
// With none, sign-in isn't available in this copy of Kea and everything on this computer works without it.
const fs = require('fs');
const path = require('path');

const BUILD_FILE = path.join(__dirname, 'buildConfig.json');

/** electron/buildConfig.json ({} when it isn't there or can't be read). */
function readBuildConfig(file = BUILD_FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const first = (...vals) => vals.map(str).find(Boolean) || '';

/**
 * The clients, from settings, then the environment, then the build config:
 * { google: { id, secret, from }, microsoft: { id, from } } (from: 'settings' | 'env' | 'build' | null).
 * `get(key)` reads a setting; `env` and `build` are for the tests.
 */
function resolveClients({ get = () => '', env = process.env, build = readBuildConfig() } = {}) {
  const b = build || {};
  const pick = (setKey, envKey, buildVal) => {
    const s = str(get(setKey));
    if (s) return { value: s, from: 'settings' };
    const e = str(env[envKey]);
    if (e) return { value: e, from: 'env' };
    const v = str(buildVal);
    return v ? { value: v, from: 'build' } : { value: '', from: null };
  };
  const gid = pick('hub.googleClientId', 'KEA_GOOGLE_CLIENT_ID', b.google?.desktopClientId);
  // (The secret goes with the client id it was made for: the same place, or the build config for the build's client.)
  const secret = gid.from === 'settings' ? first(get('hub.googleClientSecret'), env.KEA_GOOGLE_CLIENT_SECRET) : gid.from === 'env' ? first(env.KEA_GOOGLE_CLIENT_SECRET) : gid.from === 'build' ? first(b.google?.desktopClientSecret) : '';
  const ms = pick('hub.microsoftClientId', 'KEA_MICROSOFT_CLIENT_ID', b.microsoft?.clientId);
  return { google: { id: gid.value, secret, from: gid.from }, microsoft: { id: ms.value, from: ms.from } };
}

// ---------- From the Kea account server (Kea 0.102.1, KeaC 0.14 GET /v1/sign-in-clients) ----------
// A build without the owner's file has no clients built in. Then Kea asks its Kea account server once, keeps the
// answer in userData/sign-in-clients.json, and uses it like build config: so "Sign in with Google", Drive, Contacts
// and Gmail work in every copy of Kea, wherever it was built. Clients built in (or set by hand) always come first.
const serverFile = () => path.join(require('electron').app.getPath('userData'), 'sign-in-clients.json');
function readServerClients() {
  try {
    const j = JSON.parse(fs.readFileSync(serverFile(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}
/** The build's clients, with the server's filling in what the build lacks. */
function effectiveBuild(b = readBuildConfig(), s = readServerClients()) {
  return { google: str(b.google?.desktopClientId) ? b.google : s.google, microsoft: str(b.microsoft?.clientId) ? b.microsoft : s.microsoft };
}
/** Clean what the server answered: only the fields Kea uses, as strings. */
function cleanServerAnswer(j) {
  const out = {};
  const g = j?.google || {};
  if (str(g.desktopClientId)) out.google = { desktopClientId: str(g.desktopClientId), ...(str(g.desktopClientSecret) ? { desktopClientSecret: str(g.desktopClientSecret) } : {}) };
  if (str(j?.microsoft?.clientId)) out.microsoft = { clientId: str(j.microsoft.clientId) };
  return out;
}
let asking = null;
/**
 * Make sure the clients are here: when the build lacks them, ask the Kea account server (once at a time) and keep the
 * answer. Never throws (offline or an older server: Kea goes on without, as before).
 */
async function ensure() {
  const b = readBuildConfig();
  if (str(b.google?.desktopClientId) && str(b.microsoft?.clientId)) return;
  if (asking) return asking;
  asking = (async () => {
    try {
      const base = require('./hub.cjs').url();
      const r = await require('electron').net.fetch(`${base}/v1/sign-in-clients`, { headers: { 'x-kea': '1' } });
      if (!r.ok) return;
      const got = cleanServerAnswer(await r.json());
      if (!got.google && !got.microsoft) return;
      if (JSON.stringify(got) !== JSON.stringify(readServerClients())) fs.writeFileSync(serverFile(), JSON.stringify(got));
    } catch {
    } finally {
      asking = null;
    }
  })();
  return asking;
}

/** The clients as Kea's settings say now (settings.cjs is required lazily, so the tests can use this without Electron). */
function clients() {
  let get = () => '';
  try {
    const settings = require('./settings.cjs');
    get = (k) => settings.get(k, '');
  } catch {}
  let build = readBuildConfig();
  try {
    build = effectiveBuild(build);
  } catch {}
  return resolveClients({ get, build });
}

module.exports = { BUILD_FILE, readBuildConfig, resolveClients, clients, ensure, _test: { effectiveBuild, cleanServerAnswer } };

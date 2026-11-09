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

/** The clients as Kea's settings say now (settings.cjs is required lazily, so the tests can use this without Electron). */
function clients() {
  let get = () => '';
  try {
    const settings = require('./settings.cjs');
    get = (k) => settings.get(k, '');
  } catch {}
  return resolveClients({ get });
}

module.exports = { BUILD_FILE, readBuildConfig, resolveClients, clients };

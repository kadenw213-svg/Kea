// The built-in Google and Microsoft sign-in clients, put into a build from the owner's file outside the repo:
//   %LOCALAPPDATA%\KeaBuild\oauth-clients.json (or KEA_OAUTH_CLIENTS: another path)
//   { "google": { "desktopClientId", "desktopClientSecret", "androidClientId" }, "microsoft": { "clientId" } }
// It writes electron/buildConfig.json (git-ignored; packaged with the app) for Kea on the computer, and gives the
// VITE_KEA_* variables for the phone app's build. Without the owner's file the build still works: it says plainly that
// sign-in won't be available in that build. Nothing secret is printed.
//   node scripts/oauth-clients.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, '..', 'electron', 'buildConfig.json');
const ownerFile = () => process.env.KEA_OAUTH_CLIENTS || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'KeaBuild', 'oauth-clients.json');
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** The owner's file, read: { config, warning }. config is what goes into buildConfig.json ({} without the file). */
function readOwnerFile(file = ownerFile()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { config: {}, warning: `No ${file}: this build has no built-in Google or Microsoft client, so "Sign in with Google" and Google Drive won't be available in it. Everything else works. (See docs/DEVELOPING.md.)` };
  }
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return { config: {}, warning: `${file} isn't valid JSON: this build has no built-in sign-in client, so sign-in won't be available in it.` };
  }
  const g = j?.google || {};
  const m = j?.microsoft || {};
  const config = {};
  if (str(g.desktopClientId) || str(g.androidClientId)) config.google = { ...(str(g.desktopClientId) ? { desktopClientId: str(g.desktopClientId) } : {}), ...(str(g.desktopClientSecret) ? { desktopClientSecret: str(g.desktopClientSecret) } : {}), ...(str(g.androidClientId) ? { androidClientId: str(g.androidClientId) } : {}) };
  if (str(m.clientId)) config.microsoft = { clientId: str(m.clientId) };
  const warning = !config.google?.desktopClientId && !config.microsoft?.clientId ? `${file} has no google.desktopClientId or microsoft.clientId: sign-in won't be available in this build.` : null;
  return { config, warning };
}

/** The phone app's build variables (only the ones that are set). */
function mobileEnv(config) {
  return {
    ...(config.google?.androidClientId ? { VITE_KEA_GOOGLE_CLIENT_ID: config.google.androidClientId } : {}),
    ...(config.microsoft?.clientId ? { VITE_KEA_MICROSOFT_CLIENT_ID: config.microsoft.clientId } : {}),
  };
}

/** Writes electron/buildConfig.json for this build (the desktop's clients only; {} without the owner's file). */
function writeBuildConfig({ file = ownerFile(), out = OUT, log = console } = {}) {
  const { config, warning } = readOwnerFile(file);
  const desktop = {};
  if (config.google?.desktopClientId) desktop.google = { desktopClientId: config.google.desktopClientId, ...(config.google.desktopClientSecret ? { desktopClientSecret: config.google.desktopClientSecret } : {}) };
  if (config.microsoft?.clientId) desktop.microsoft = { clientId: config.microsoft.clientId };
  fs.writeFileSync(out, JSON.stringify(desktop, null, 1) + '\n');
  if (warning) log.warn(`\nWarning: ${warning}\n`);
  else log.log(`Built-in sign-in: ${[desktop.google && 'Google', desktop.microsoft && 'Microsoft'].filter(Boolean).join(' and ') || 'none'} (from ${file}).`);
  return { config, desktop, warning, env: mobileEnv(config) };
}

module.exports = { OUT, ownerFile, readOwnerFile, mobileEnv, writeBuildConfig };

if (require.main === module) writeBuildConfig();

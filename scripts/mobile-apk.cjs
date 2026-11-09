// Builds Kea for Android (an installable APK) from mobile/, using the Java and Android SDK Kea's setup put in
// %LOCALAPPDATA%\KeaBuild. The APK lands in %LOCALAPPDATA%\KeaBuild\Kea.apk (outside OneDrive).
//
// It's a release build (not debuggable), signed with Kea's own release key, which is never in the repository. Where
// the key is comes from, in order:
//   - KEA_ANDROID_SIGNING: the path of a signing properties file;
//   - %APPDATA%\KeaBuild\android-signing.properties.
// The properties (paths may be relative to the file; `include=<path>` reads another file):
//   storeFile, storePassword, keyAlias, keyPassword   the release key;
//   lineageFile, oldStoreFile, oldStorePassword, oldKeyAlias, oldKeyPassword
//                                                     key rotation (APK Signature Scheme v3) from the debug key that
//                                                     signed Kea until now, so installed copies keep updating.
// Each can also be given as an environment variable: KEA_ANDROID_STORE_FILE, KEA_ANDROID_STORE_PASSWORD, and so on.
// With no signing set up, the build stops and says so (it never falls back to the debug key).
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const kb = path.join(process.env.LOCALAPPDATA, 'KeaBuild');
const env = { ...process.env, JAVA_HOME: path.join(kb, 'jdk'), ANDROID_HOME: path.join(kb, 'android-sdk'), ANDROID_SDK_ROOT: path.join(kb, 'android-sdk') };
// Windows names it "Path": add Java in front under whatever name it already has.
const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
env[pathKey] = `${path.join(env.JAVA_HOME, 'bin')};${env[pathKey]}`;
const mobile = path.join(__dirname, '..', 'mobile');
const run = (cmd, cwd) => execSync(cmd, { stdio: 'inherit', cwd, env });
const q = (a) => {
  if (/["%]/.test(a)) stop(`Can't pass ${a} to the Android tools.`);
  return `"${a}"`;
};
function stop(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

/** The signing settings, or a clear stop. */
function signing() {
  const KEYS = ['storeFile', 'storePassword', 'keyAlias', 'keyPassword', 'lineageFile', 'oldStoreFile', 'oldStorePassword', 'oldKeyAlias', 'oldKeyPassword'];
  const envName = (k) => 'KEA_ANDROID_' + k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase();
  const props = {};
  const read = (file, depth = 0) => {
    const dir = path.dirname(file);
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z]+)\s*[=:]\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      const [, k, v] = m;
      if (k === 'include') {
        const inc = path.resolve(dir, v);
        if (depth > 3 || !fs.existsSync(inc)) stop(`The signing file ${file} points to ${inc}, which isn't there (is the drive with Kea's keys plugged in?).`);
        read(inc, depth + 1);
      } else if (KEYS.includes(k)) props[k] = /File$/.test(k) ? path.resolve(dir, v) : v;
    }
  };
  const file = process.env.KEA_ANDROID_SIGNING || path.join(process.env.APPDATA || '', 'KeaBuild', 'android-signing.properties');
  if (fs.existsSync(file)) read(file);
  for (const k of KEYS) if (process.env[envName(k)]) props[k] = process.env[envName(k)];
  const missing = KEYS.filter((k) => !props[k]);
  if (missing.length)
    stop(
      `Kea for Android is signed with Kea's release key, and the signing settings are missing: ${missing.join(', ')}.\n` +
        `Put them in ${file} (or set KEA_ANDROID_SIGNING to a properties file, or the KEA_ANDROID_* variables). See the top of scripts/mobile-apk.cjs.`
    );
  for (const k of KEYS.filter((k) => /File$/.test(k))) if (!fs.existsSync(props[k])) stop(`Signing: ${k} ${props[k]} isn't there (is the drive with Kea's keys plugged in?).`);
  return props;
}

// (Checked first, so a build without the keys stops before the long part.)
const sign = signing();
const tools = (() => {
  const bt = path.join(env.ANDROID_HOME, 'build-tools');
  const v = fs.existsSync(bt) ? fs.readdirSync(bt).filter((d) => /^\d+\./.test(d)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop() : null;
  if (!v) stop(`No Android build tools in ${bt}.`);
  return { apksigner: path.join(bt, v, 'apksigner.bat'), zipalign: path.join(bt, v, 'zipalign.exe'), aapt: path.join(bt, v, 'aapt.exe') };
})();

fs.writeFileSync(path.join(mobile, 'android', 'local.properties'), `sdk.dir=${env.ANDROID_HOME.replace(/\\/g, '\\\\')}\n`);
// The built-in sign-in clients (the Android Google client and Microsoft's), from the owner's file outside the repo:
// they go into the phone app's build as VITE_KEA_* (a warning without it; sign-in isn't available in that build).
// Ones already in the environment win.
{
  const { readOwnerFile, mobileEnv } = require('./oauth-clients.cjs');
  const { config, warning } = readOwnerFile();
  if (warning) console.warn(`\nWarning: ${warning}\n`);
  for (const [k, v] of Object.entries(mobileEnv(config))) if (!env[k]) env[k] = v;
  env.KEA_OAUTH_CHECKED = '1';
}
run('npx vite build', mobile);
run('npx cap sync android', mobile);
// Kea's colours for class sites: the desktop's own script, injected by the phone's class-site screen.
fs.copyFileSync(path.join(__dirname, '..', 'electron', 'scholar', 'site-theme.js'), path.join(mobile, 'android', 'app', 'src', 'main', 'assets', 'site-theme.js'));
run('.\\gradlew.bat assembleRelease --no-daemon -q', path.join(mobile, 'android'));
const outDir = path.join(kb, 'mobile-build', 'app', 'outputs', 'apk', 'release');
const unsigned = path.join(outDir, 'app-release-unsigned.apk');
if (!fs.existsSync(unsigned)) stop(`The release build didn't produce ${unsigned}.`);

// Aligned, then signed: v1 and v2 with the old key (Android 8.1 and older know no rotation), v3 with the new key and
// the lineage from the old one (Android 9 and later), so every installed copy accepts the update.
const aligned = path.join(outDir, 'app-release-aligned.apk');
run(`${q(tools.zipalign)} -p -f 4 ${q(unsigned)} ${q(aligned)}`);
const apk = path.join(kb, 'Kea.apk');
// (Passwords go to apksigner through the environment, never on its command line.)
const senv = { ...env, KEA_SIGN_OLD_STORE: sign.oldStorePassword, KEA_SIGN_OLD_KEY: sign.oldKeyPassword, KEA_SIGN_STORE: sign.storePassword, KEA_SIGN_KEY: sign.keyPassword };
execSync(
  [
    q(tools.apksigner), 'sign',
    '--ks', q(sign.oldStoreFile), '--ks-key-alias', q(sign.oldKeyAlias), '--ks-pass', 'env:KEA_SIGN_OLD_STORE', '--key-pass', 'env:KEA_SIGN_OLD_KEY',
    '--next-signer',
    '--ks', q(sign.storeFile), '--ks-key-alias', q(sign.keyAlias), '--ks-pass', 'env:KEA_SIGN_STORE', '--key-pass', 'env:KEA_SIGN_KEY',
    '--lineage', q(sign.lineageFile),
    '--rotation-min-sdk-version', '28',
    '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true',
    '--out', q(apk), q(aligned)
  ].join(' '),
  { stdio: 'inherit', env: senv }
);
fs.rmSync(aligned, { force: true });
// (Checked before it's offered: the signatures, the rotation, and that it isn't debuggable.)
const verify = execSync(`${q(tools.apksigner)} verify -v --print-certs ${q(apk)}`, { env }).toString();
if (!/Verified using v3 scheme \(APK Signature Scheme v3\): true/.test(verify)) stop(`The APK isn't signed with v3:\n${verify}`);
const badging = execSync(`${q(tools.aapt)} dump badging ${q(apk)}`, { env, maxBuffer: 64 << 20 }).toString();
if (/application-debuggable/.test(badging)) stop('The APK is debuggable: release builds must not be.');
console.log(`\nBuilt ${apk} (${(fs.statSync(apk).size / 1048576).toFixed(1)} MB): a release build, signed with Kea's release key (rotated from the old debug key).\n`);

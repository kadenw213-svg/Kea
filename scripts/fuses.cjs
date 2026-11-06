// electron-builder afterPack hook: lock down the packaged Electron with its fuses (switches compiled into the app's
// executable), so the installed Kea can't be turned into something else by whoever can start it with options:
//   - RunAsNode off: ELECTRON_RUN_AS_NODE can't run Kea.exe as a plain Node.js with Kea's name and signature;
//   - NODE_OPTIONS and --inspect / --inspect-brk off: no code injected at start-up, no debugger attached;
//   - cookies encrypted on disk (the class site's session);
//   - only the app inside app.asar is loaded, and app.asar must match the hash baked into the executable (a changed
//     app.asar, say with a line added to main.cjs, won't start).
// electron-builder 25 bakes the app.asar hash into the executable but doesn't flip fuses (its electronFuses option
// came in 26), so this checks the hash is there and flips them, before the executable is signed.
//
// The fuse wire: a sentinel, then a version byte, a length byte and one byte per fuse ('0' off, '1' on, 'r' removed).
const fs = require('fs');
const path = require('path');

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
// Electron's FuseV1Options order.
const FUSE = { RunAsNode: 0, EnableCookieEncryption: 1, EnableNodeOptionsEnvironmentVariable: 2, EnableNodeCliInspectArguments: 3, EnableEmbeddedAsarIntegrityValidation: 4, OnlyLoadAppFromAsar: 5 };
const WANT = { RunAsNode: false, EnableCookieEncryption: true, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false, EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true };

/** Flip the fuses in one binary; returns what they were and are. Throws when the wire isn't found exactly once. */
function flipFuses(file, want = WANT) {
  const buf = fs.readFileSync(file);
  const at = buf.indexOf(SENTINEL);
  if (at < 0 || buf.indexOf(SENTINEL, at + 1) >= 0) throw new Error(`fuses: the fuse wire wasn't found exactly once in ${file}`);
  const version = buf[at + SENTINEL.length];
  const len = buf[at + SENTINEL.length + 1];
  if (version !== 1) throw new Error(`fuses: unknown fuse wire version ${version} in ${file}`);
  const start = at + SENTINEL.length + 2;
  const before = buf.subarray(start, start + len).toString('latin1');
  for (const [name, on] of Object.entries(want)) {
    const i = FUSE[name];
    if (i >= len) throw new Error(`fuses: ${name} isn't in this Electron's fuse wire`);
    if (buf[start + i] === 0x72) throw new Error(`fuses: ${name} was removed from this Electron`);
    buf[start + i] = on ? 0x31 : 0x30;
  }
  fs.writeFileSync(file, buf);
  return { before, after: buf.subarray(start, start + len).toString('latin1') };
}

/**
 * Windows: the app.asar hash electron-builder wrote into the executable (resource INTEGRITY/ELECTRONASAR, which Electron
 * checks once the fuse is on). Without it, turning the fuse on would stop Kea from starting, so its absence (or a hash
 * that doesn't match app.asar) fails the build instead.
 */
async function checkAsarIntegrity(exe, resourcesDir) {
  const ResEdit = require('resedit');
  const pe = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const entry = ResEdit.NtExecutableResource.from(pe).entries.find((e) => e.type === 'INTEGRITY' && e.id === 'ELECTRONASAR');
  if (!entry) throw new Error(`fuses: ${path.basename(exe)} has no app.asar hash (INTEGRITY/ELECTRONASAR); the asar integrity fuse would stop it starting`);
  const list = JSON.parse(Buffer.from(entry.bin).toString('utf8'));
  const { computeData } = require('app-builder-lib/out/asar/integrity');
  const now = await computeData({ resourcesPath: resourcesDir, resourcesRelativePath: 'resources' });
  const asar = list.find((x) => /(^|[\\/])app\.asar$/i.test(x.file));
  const want = Object.entries(now).find(([f]) => /(^|[\\/])app\.asar$/i.test(f));
  if (!asar || !want || String(asar.value).toLowerCase() !== String(want[1].hash).toLowerCase()) throw new Error('fuses: the app.asar hash in the executable doesn’t match app.asar');
  return list;
}

async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const name = packager.appInfo.productFilename;
  if (electronPlatformName === 'win32') {
    const exe = path.join(appOutDir, `${name}.exe`);
    const list = await checkAsarIntegrity(exe, path.join(appOutDir, 'resources'));
    const f = flipFuses(exe);
    console.log(`  • fuses  ${path.basename(exe)}: ${f.before} -> ${f.after}; app.asar hash ${list.map((x) => x.value.slice(0, 12)).join(', ')}`);
  } else if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
    // (On a Mac, electron-builder already writes the app.asar hash into Info.plist.)
    const bin = path.join(appOutDir, `${name}.app`, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
    const f = flipFuses(bin);
    console.log(`  • fuses  Electron Framework: ${f.before} -> ${f.after}`);
  } else {
    const bin = path.join(appOutDir, packager.executableName || name);
    if (fs.existsSync(bin)) flipFuses(bin, { ...WANT, EnableEmbeddedAsarIntegrityValidation: false });
  }
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.flipFuses = flipFuses;
module.exports.SENTINEL = SENTINEL;

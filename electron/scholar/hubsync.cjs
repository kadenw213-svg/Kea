// Kea Hub sync: the "Kea Hub" drive. Kea writes its sync folder exactly as it does into OneDrive (cloud.cjs,
// devices.cjs), but the folder is a local one in Kea's own data, and this mirrors it to the person's Kea storage on
// the Hub, both ways, instead of a cloud drive's sync app.
//
// - Only changed files move: each file's Hub version is remembered, and a file is sent only when it changed here.
// - Changes from other devices come from "what changed since <time>"; deletions from a full listing every 5 minutes.
// - Every file has one writer in Kea's device protocol (the primary writes the classes, each device its own card), so
//   a clash is rare; when one happens, this device's change wins (it re-sends over the newer version).
// - A file still being written (changed in the last 1.5 s) waits for the next pass.
//
// Paths on the Hub are "kea/<path in the folder>". Characters the Hub doesn't allow in names become ~<hex>~.
//
// Kea cloud (keaCloud.cjs) keeps the person's documents in "Documents/" inside this folder:
// - `scope()` (asked once per pass) says which files this pass syncs: only Documents/ when Scholar syncs through
//   another drive, everything when it syncs through the Kea Hub.
// - `keepBoth(rel)`: for documents a clash keeps both: the Hub's copy is saved beside this one as
//   "<name> (from another device).<ext>" before this device's change is sent, so nobody's edits are lost.
// - A full Kea storage (the Hub answers 507) skips that file and says so in `state().full`; the rest still syncs.
const fs = require('fs');
const path = require('path');

const ALLOWED = /[\p{L}\p{N} ._()+@,'&!-]/u;
const encodeSeg = (s) => [...s].map((c) => (ALLOWED.test(c) ? c : `~${c.codePointAt(0).toString(16)}~`)).join('');
/** A segment's name, or null when it holds a ~hex~ that isn't a code point (over 10FFFF): never throws. */
const decodeSeg = (s) => {
  let bad = false;
  const out = String(s).replace(/~([0-9a-f]+)~/g, (_, h) => {
    const n = h.length <= 6 ? parseInt(h, 16) : Infinity;
    if (!(n <= 0x10ffff)) {
      bad = true;
      return '';
    }
    return String.fromCodePoint(n);
  });
  return bad ? null : out;
};
const toRemote = (rel) => `kea/${rel.split(/[\\/]/).map(encodeSeg).join('/')}`;
/** A Hub path as a local relative path, or null when a segment's name is invalid. */
const toLocal = (remote) => {
  const segs = remote.slice(4).split('/').map(decodeSeg);
  return segs.includes(null) ? null : segs.join('/');
};
// Windows' reserved device names, with or without an extension ("NUL", "con.txt").
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
/**
 * A Hub path as a path inside the sync folder, or null when it isn't a plain one. The Hub's listing decides what is
 * written here, so a name that could leave the folder ("..", "~2e~~2e~", a drive, a separator hidden in ~hex~, an
 * alternate data stream, a device name) is never used, whatever the Hub sends.
 */
function safeLocal(remote) {
  if (typeof remote !== 'string' || !remote.startsWith('kea/') || remote.length > 2048) return null;
  const segs = remote.slice(4).split('/').map(decodeSeg);
  if (!segs.length) return null;
  for (const g of segs) {
    if (!g || g === '.' || g === '..' || g.length > 255) return null;
    if (/[\\/:*?"<>|\x00-\x1f\x7f]/.test(g) || /[. ]$/.test(g) || RESERVED.test(g)) return null;
  }
  return segs.join('/');
}
/** The file's place on disk, only when it's inside `root`. */
function inside(root, rel) {
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  return abs.startsWith(base + path.sep) ? abs : null;
}
const MAX = 64 * 1024 * 1024;
const FULL_EVERY = 5 * 60_000;
const SETTLE = 1500;

/**
 * client: { list(since) -> { files: [{ path, version, size, updatedAt }], now }, get(path) -> Buffer,
 *           put(path, data, { ifMatch, ifNoneMatch }) -> { version } (throws { status, data } on 412/400/413/507),
 *           del(path, { ifMatch }) }
 */
function createSync({ root, stateFile, client, log = () => {}, now = Date.now, scope = () => () => true, keepBoth = () => false }) {
  let st = { files: {}, since: 0, fullAt: 0, skip: {}, storage: null, full: null, conflicts: [] };
  try {
    st = { ...st, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
  } catch {}
  const save = () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(st));
    fs.renameSync(`${stateFile}.tmp`, stateFile);
  };
  const statOf = (rel) => {
    try {
      const s = fs.statSync(path.join(root, rel));
      return s.isFile() ? s : null;
    } catch {
      return null;
    }
  };
  const same = (s, rec) => s && rec && s.size === rec.size && Math.abs(s.mtimeMs - rec.mtime) < 1;
  const counts = { up: 0, down: 0, deleted: 0, bytesUp: 0, bytesDown: 0 };
  let inScope = () => true;

  function walk(dir = root, prefix = '', out = []) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel, out);
      else if (!skipName(e.name) && inScope(rel)) out.push(rel);
    }
    return out;
  }

  async function pull() {
    const full = now() - st.fullAt > FULL_EVERY;
    const list = await client.list(full ? 0 : st.since);
    if (list.quota != null) st.storage = { used: list.used, quota: list.quota };
    const seen = new Set();
    for (const f of list.files) {
      if (!f.path.startsWith('kea/')) continue;
      const rel = safeLocal(f.path);
      if (!rel || !inside(root, rel)) {
        log(`Kea cloud sync: skipped a file with a name that isn't allowed here (${String(f.path).slice(0, 120)}).`);
        continue;
      }
      if (!inScope(rel)) continue;
      seen.add(rel);
      const rec = st.files[rel];
      if (rec && rec.v === f.version) continue;
      const s = statOf(rel);
      // Changed here since it was last synced (or new here and not yet sent): this device's copy wins; push sends it.
      if (s && (!rec || !same(s, rec))) continue;
      const data = await client.get(f.path);
      const file = inside(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.part`, data);
      fs.renameSync(`${file}.part`, file);
      const after = fs.statSync(file);
      st.files[rel] = { v: f.version, size: after.size, mtime: after.mtimeMs };
      counts.down++;
      counts.bytesDown += data.length;
    }
    if (full) {
      // Gone from the Hub (another device deleted it) and unchanged here: delete it here too. Safety, as for sending:
      // if most of the files seem gone from the Hub at once, the listing is wrong (or the Hub is), not a real
      // deletion; nothing is deleted here then.
      const tracked = Object.keys(st.files).filter((rel) => inScope(rel));
      const gone = tracked.filter((rel) => !seen.has(rel));
      if (gone.length > 20 && gone.length > tracked.length / 2) {
        log(`Kea cloud sync: ${gone.length} of ${tracked.length} files are missing from Kea cloud at once, so none were deleted here.`);
        st.fullAt = now();
        st.since = Math.max(0, (list.now ?? now()) - 5000);
        return;
      }
      for (const rel of gone) {
        const file = inside(root, rel);
        if (!file || safeLocal(toRemote(rel)) == null) {
          delete st.files[rel];
          continue;
        }
        const s = statOf(rel);
        if (!s || same(s, st.files[rel])) {
          if (s) fs.rmSync(file, { force: true });
          delete st.files[rel];
          counts.deleted++;
        }
      }
      st.fullAt = now();
    }
    // (A little overlap, so a change made at the same moment as the listing isn't missed.)
    st.since = Math.max(0, (list.now ?? now()) - 5000);
  }

  async function push() {
    const t = now();
    const here = new Set();
    let full = null;
    for (const rel of walk()) {
      here.add(rel);
      const s = statOf(rel);
      if (!s || same(s, st.files[rel]) || t - s.mtimeMs < SETTLE) continue;
      if (s.size > MAX) {
        if (st.skip[rel] !== s.size) log(`Kea cloud sync: ${rel} is over 64 MB, so it stays on this computer.`);
        st.skip[rel] = s.size;
        continue;
      }
      const data = fs.readFileSync(path.join(root, rel));
      const rec = st.files[rel];
      const send = (opts) => client.put(toRemote(rel), data, opts);
      let r;
      try {
        r = await send(rec ? { ifMatch: rec.v } : { ifNoneMatch: true });
      } catch (e) {
        if (e.status === 412) {
          // Changed on the Hub too: this device's change wins, sent over whatever is there now. A document keeps the
          // Hub's copy beside it first.
          const v = e.data?.version;
          if (v && keepBoth(rel)) await keepTheirs(rel);
          try {
            r = await send(v ? { ifMatch: v } : { ifNoneMatch: true });
          } catch (e2) {
            if (e2.status !== 507) throw e2;
            full = noteFull(rel, e2);
            continue;
          }
        } else if (e.status === 507) {
          full = noteFull(rel, e);
          continue;
        } else if (e.status === 400) {
          if (st.skip[rel] !== 'name') log(`Kea cloud sync: ${rel} has a name Kea cloud can't store, so it stays on this computer.`);
          st.skip[rel] = 'name';
          continue;
        } else throw e;
      }
      // (The storage used, kept current between listings: the Hub counts each file's size.)
      if (st.storage) st.storage.used = Math.max(0, st.storage.used + data.length - (rec?.size || 0));
      st.files[rel] = { v: r.version, size: s.size, mtime: s.mtimeMs };
      if (st.skip[rel] === 'full') delete st.skip[rel];
      counts.up++;
      counts.bytesUp += data.length;
    }
    st.full = full;
    // Deleted here (for example a request the primary took in): delete it on the Hub. Safety: if most of the files
    // seem to have vanished at once, the folder is probably unreadable (a moved profile, a drive hiccup), not
    // deleted; nothing is deleted on the Hub then.
    const tracked = Object.keys(st.files).filter((rel) => inScope(rel));
    const missing = tracked.filter((rel) => !here.has(rel));
    if (missing.length > 20 && missing.length > tracked.length / 2) {
      log(`Kea cloud sync: ${missing.length} of ${tracked.length} files are missing here at once, so none were deleted in Kea cloud.`);
      return;
    }
    for (const rel of missing) {
      if (here.has(rel)) continue;
      try {
        await client.del(toRemote(rel), { ifMatch: st.files[rel].v });
      } catch (e) {
        if (e.status !== 404 && e.status !== 412) throw e;
      }
      if (st.storage) st.storage.used = Math.max(0, st.storage.used - (st.files[rel].size || 0));
      delete st.files[rel];
      counts.deleted++;
    }
  }

  /** The Hub's copy of a clashing document, saved beside this device's as "<name> (from another device).<ext>". */
  async function keepTheirs(rel) {
    let data;
    try {
      data = await client.get(toRemote(rel));
    } catch (e) {
      if (e.status === 404) return;
      throw e;
    }
    const to = conflictName(rel, (r) => !!statOf(r) || !!st.files[r]);
    const file = inside(root, to);
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.part`, data);
    fs.renameSync(`${file}.part`, file);
    st.conflicts = [...(st.conflicts || []), { rel, copy: to, at: now() }].slice(-20);
    log(`Kea cloud sync: ${rel} changed on another device too; that version is kept as ${to}.`);
  }
  function noteFull(rel, e) {
    if (st.skip[rel] !== 'full') log(`Kea cloud sync: Kea storage is full, so ${rel} stays on this computer for now.`);
    st.skip[rel] = 'full';
    if (e.data?.quota != null) st.storage = { used: e.data.used, quota: e.data.quota };
    return { at: now(), message: e.message || 'Your Kea storage is full.' };
  }

  let running = null;
  /** One pass: bring in others' changes, then send this device's. Overlapping calls share one pass. */
  function cycle() {
    if (running) return running;
    running = (async () => {
      try {
        fs.mkdirSync(root, { recursive: true });
        inScope = scope() || (() => true);
        await pull();
        await push();
      } finally {
        save();
        running = null;
      }
      return { ...counts };
    })();
    return running;
  }
  return { cycle, state: () => st, counts };
}

/** The client for a real Hub: `fetchFn` (Electron's net.fetch), the Hub's address and the session token. */
function httpClient({ base, token, fetchFn, client = 'Kea' }) {
  const H = () => ({ authorization: `Bearer ${token()}`, 'x-kea': '1', 'x-kea-client': client });
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const fail = async (r) => {
    const data = await r.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || `Kea cloud said ${r.status}`), { status: r.status, data });
  };
  return {
    async list(since) {
      const r = await fetchFn(`${base()}/v1/files?prefix=kea/&since=${since || 0}`, { headers: H() });
      if (!r.ok) await fail(r);
      return r.json();
    },
    async get(p) {
      const r = await fetchFn(`${base()}/v1/files/${enc(p)}`, { headers: H() });
      if (!r.ok) await fail(r);
      return Buffer.from(await r.arrayBuffer());
    },
    async put(p, data, { ifMatch, ifNoneMatch } = {}) {
      const r = await fetchFn(`${base()}/v1/files/${enc(p)}`, { method: 'PUT', headers: { ...H(), ...(ifMatch ? { 'if-match': `"${ifMatch}"` } : {}), ...(ifNoneMatch ? { 'if-none-match': '*' } : {}) }, body: data });
      if (!r.ok) await fail(r);
      return r.json();
    },
    async del(p, { ifMatch } = {}) {
      const r = await fetchFn(`${base()}/v1/files/${enc(p)}`, { method: 'DELETE', headers: { ...H(), ...(ifMatch ? { 'if-match': `"${ifMatch}"` } : {}) } });
      if (!r.ok) await fail(r);
      return r.json();
    },
  };
}

/** Files never synced: half-written saves (Kea's own .kea-tmp, .tmp, .part) and Office's "~$" lock files. */
const skipName = (name) => /\.(tmp|part|kea-tmp)$/i.test(name) || name.startsWith('~$');

/** "Essay.docx" -> "Essay (from another device).docx", or "... 2" and up when that's taken. */
function conflictName(rel, taken) {
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  const file = rel.slice(dir.length);
  const dot = file.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ''];
  for (let n = 1; ; n++) {
    const cand = `${dir}${base} (from another device${n > 1 ? ` ${n}` : ''})${ext}`;
    if (!taken(cand)) return cand;
  }
}

module.exports = { createSync, httpClient, encodeSeg, decodeSeg, toRemote, toLocal, safeLocal, inside, conflictName, skipName };

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
const fs = require('fs');
const path = require('path');

const ALLOWED = /[\p{L}\p{N} ._()+@,'&!-]/u;
const encodeSeg = (s) => [...s].map((c) => (ALLOWED.test(c) ? c : `~${c.codePointAt(0).toString(16)}~`)).join('');
const decodeSeg = (s) => s.replace(/~([0-9a-f]+)~/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
const toRemote = (rel) => `kea/${rel.split(/[\\/]/).map(encodeSeg).join('/')}`;
const toLocal = (remote) => remote.slice(4).split('/').map(decodeSeg).join('/');
const MAX = 64 * 1024 * 1024;
const FULL_EVERY = 5 * 60_000;
const SETTLE = 1500;

/**
 * client: { list(since) -> { files: [{ path, version, size, updatedAt }], now }, get(path) -> Buffer,
 *           put(path, data, { ifMatch, ifNoneMatch }) -> { version } (throws { status, data } on 412/400/413/507),
 *           del(path, { ifMatch }) }
 */
function createSync({ root, stateFile, client, log = () => {}, now = Date.now }) {
  let st = { files: {}, since: 0, fullAt: 0, skip: {} };
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
      else if (!/\.(tmp|part)$/i.test(e.name)) out.push(rel);
    }
    return out;
  }

  async function pull() {
    const full = now() - st.fullAt > FULL_EVERY;
    const list = await client.list(full ? 0 : st.since);
    const seen = new Set();
    for (const f of list.files) {
      if (!f.path.startsWith('kea/')) continue;
      const rel = toLocal(f.path);
      seen.add(rel);
      const rec = st.files[rel];
      if (rec && rec.v === f.version) continue;
      const s = statOf(rel);
      // Changed here since it was last synced (or new here and not yet sent): this device's copy wins; push sends it.
      if (s && (!rec || !same(s, rec))) continue;
      const data = await client.get(f.path);
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.part`, data);
      fs.renameSync(`${file}.part`, file);
      const after = fs.statSync(file);
      st.files[rel] = { v: f.version, size: after.size, mtime: after.mtimeMs };
      counts.down++;
      counts.bytesDown += data.length;
    }
    if (full) {
      // Gone from the Hub (another device deleted it) and unchanged here: delete it here too.
      for (const rel of Object.keys(st.files)) {
        if (seen.has(rel)) continue;
        const s = statOf(rel);
        if (!s || same(s, st.files[rel])) {
          if (s) fs.rmSync(path.join(root, rel), { force: true });
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
    for (const rel of walk()) {
      here.add(rel);
      const s = statOf(rel);
      if (!s || same(s, st.files[rel]) || t - s.mtimeMs < SETTLE) continue;
      if (s.size > MAX) {
        if (st.skip[rel] !== s.size) log(`Kea Hub sync: ${rel} is over 64 MB, so it stays on this computer.`);
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
          // Changed on the Hub too: this device's change wins, sent over whatever is there now.
          const v = e.data?.version;
          r = await send(v ? { ifMatch: v } : { ifNoneMatch: true });
        } else if (e.status === 400) {
          if (st.skip[rel] !== 'name') log(`Kea Hub sync: ${rel} has a name the Hub can't store, so it stays on this computer.`);
          st.skip[rel] = 'name';
          continue;
        } else throw e;
      }
      st.files[rel] = { v: r.version, size: s.size, mtime: s.mtimeMs };
      counts.up++;
      counts.bytesUp += data.length;
    }
    // Deleted here (for example a request the primary took in): delete it on the Hub. Safety: if most of the files
    // seem to have vanished at once, the folder is probably unreadable (a moved profile, a drive hiccup), not
    // deleted; nothing is deleted on the Hub then.
    const tracked = Object.keys(st.files);
    const missing = tracked.filter((rel) => !here.has(rel));
    if (missing.length > 20 && missing.length > tracked.length / 2) {
      log(`Kea Hub sync: ${missing.length} of ${tracked.length} files are missing here at once, so none were deleted on the Hub.`);
      return;
    }
    for (const rel of missing) {
      if (here.has(rel)) continue;
      try {
        await client.del(toRemote(rel), { ifMatch: st.files[rel].v });
      } catch (e) {
        if (e.status !== 404 && e.status !== 412) throw e;
      }
      delete st.files[rel];
      counts.deleted++;
    }
  }

  let running = null;
  /** One pass: bring in others' changes, then send this device's. Overlapping calls share one pass. */
  function cycle() {
    if (running) return running;
    running = (async () => {
      try {
        fs.mkdirSync(root, { recursive: true });
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
    throw Object.assign(new Error(data.error || `Kea Hub said ${r.status}`), { status: r.status, data });
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

module.exports = { createSync, httpClient, encodeSeg, decodeSeg, toRemote, toLocal };

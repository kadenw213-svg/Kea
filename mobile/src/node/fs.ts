// A small file system in memory, for the parts of Kea on the PC that the phone runs as they are (study.cjs): the PC's
// study folder is loaded into it from kea-data.json, and every write is reported, so the phone keeps (and sends back)
// what changed here.
type Entry = { data: string; mtime: number };
const files = new Map<string, Entry>();
let tick = Date.now();
let hook: ((path: string, data: string | null) => void) | null = null;

const norm = (p: string) => String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
const missing = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });

/** Called with every path written (or deleted: null) after `load`. */
export function onWrite(f: typeof hook) {
  hook = f;
}
/** Put files in without reporting them (the PC's copy). */
export function load(entries: Record<string, string>) {
  for (const [p, data] of Object.entries(entries)) files.set(norm(p), { data, mtime: ++tick });
}
/** Forget everything under a folder (before loading a new copy), without reporting it. */
export function clear(prefix: string) {
  const p = norm(prefix);
  for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k);
}

export function existsSync(p: string) {
  const n = norm(p);
  if (files.has(n)) return true;
  for (const k of files.keys()) if (k.startsWith(`${n}/`)) return true;
  return false;
}
export function readFileSync(p: string, _enc?: unknown) {
  const e = files.get(norm(p));
  if (!e) throw missing(p);
  return e.data;
}
export function writeFileSync(p: string, data: unknown) {
  const n = norm(p);
  const s = typeof data === 'string' ? data : String(data);
  files.set(n, { data: s, mtime: ++tick });
  hook?.(n, s);
}
export function mkdirSync(_p: string, _o?: unknown) {}
export function readdirSync(p: string, opts?: { withFileTypes?: boolean }) {
  const pre = `${norm(p)}/`;
  const seen = new Map<string, boolean>();
  for (const k of files.keys())
    if (k.startsWith(pre)) {
      const rest = k.slice(pre.length);
      const name = rest.split('/')[0];
      seen.set(name, (seen.get(name) || false) || rest.includes('/'));
    }
  if (!seen.size && !existsSync(p)) throw missing(p);
  const names = [...seen.keys()].sort();
  return opts?.withFileTypes ? names.map((name) => ({ name, isDirectory: () => !!seen.get(name), isFile: () => !seen.get(name) })) : names;
}
export function statSync(p: string) {
  const n = norm(p);
  const e = files.get(n);
  if (e) return { mtimeMs: e.mtime, size: e.data.length, isDirectory: () => false, isFile: () => true };
  let m = 0;
  let found = false;
  for (const [k, v] of files)
    if (k.startsWith(`${n}/`)) {
      found = true;
      m = Math.max(m, v.mtime);
    }
  if (!found) throw missing(p);
  return { mtimeMs: m, size: 0, isDirectory: () => true, isFile: () => false };
}
export function rmSync(p: string, _o?: unknown) {
  const n = norm(p);
  for (const k of [...files.keys()])
    if (k === n || k.startsWith(`${n}/`)) {
      files.delete(k);
      hook?.(k, null);
    }
}
export function renameSync(a: string, b: string) {
  const e = files.get(norm(a));
  if (!e) throw missing(a);
  files.delete(norm(a));
  hook?.(norm(a), null);
  writeFileSync(b, e.data);
}
export function copyFileSync(a: string, b: string) {
  writeFileSync(b, readFileSync(a));
}

export default { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, renameSync, copyFileSync };

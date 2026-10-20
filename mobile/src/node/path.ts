// Node's path module, the few parts study.cjs uses, for the phone's in-memory files (always "/" separated).
const clean = (parts: string[]) => {
  const out: string[] = [];
  for (const p of parts.join('/').split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out;
};
export const sep = '/';
export function join(...parts: string[]) {
  const abs = String(parts[0] || '').startsWith('/');
  return `${abs ? '/' : ''}${clean(parts.map(String)).join('/')}`;
}
export const resolve = (...parts: string[]) => join('/', ...parts);
export function dirname(p: string) {
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? (s.startsWith('/') ? '/' : '.') : s.slice(0, i);
}
export function basename(p: string, ext?: string) {
  const b = String(p).replace(/\/+$/, '').split('/').pop() || '';
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
}
export function extname(p: string) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i) : '';
}
export function relative(from: string, to: string) {
  const a = clean([from]);
  const b = clean([to]);
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}
export default { sep, join, resolve, dirname, basename, extname, relative };

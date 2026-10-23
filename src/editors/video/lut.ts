// 3D colour LUTs (.cube files — the format colourists and LUT packs use). A LUT is parsed once per file and cached;
// the ClipFx shader applies it after the clip's colour correction, blended by an amount. WebGL 1 has no 3D textures,
// so the cube is laid out as N slices side by side in a 2D texture (N² × N) and sampled with blending between slices.
import { api } from '../../lib/api';
import type { Project } from './model';

export interface Lut {
  size: number;
  /** RGBA8, (N·N) × N: x = r + b·N, y = g. */
  data: Uint8Array;
  title: string;
}

const cache = new Map<string, Lut>();
const loading = new Map<string, Promise<Lut>>();
const listeners = new Set<() => void>();

export const getLut = (path: string) => cache.get(path);
/** Called when a LUT finishes loading (the preview redraws). */
export function onLutLoaded(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Parse .cube text (3D only). Throws a clear error for 1D LUTs or malformed files. */
export function parseCube(text: string, name = 'LUT'): Lut {
  let size = 0;
  let title = name;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const up = line.toUpperCase();
    if (up.startsWith('TITLE')) title = line.replace(/^TITLE\s+/i, '').replace(/^"|"$/g, '') || title;
    else if (up.startsWith('LUT_1D_SIZE')) throw new Error('This is a 1D LUT; Kea uses 3D .cube LUTs.');
    else if (up.startsWith('LUT_3D_SIZE')) size = parseInt(line.split(/\s+/)[1], 10);
    else if (up.startsWith('DOMAIN_MIN')) min = line.split(/\s+/).slice(1, 4).map(Number);
    else if (up.startsWith('DOMAIN_MAX')) max = line.split(/\s+/).slice(1, 4).map(Number);
    else if (/^[-+.\d]/.test(line)) {
      const p = line.split(/\s+/);
      vals.push(+p[0], +p[1], +p[2]);
    }
  }
  if (!size || size < 2 || size > 128) throw new Error('Not a 3D .cube LUT (no LUT_3D_SIZE).');
  if (vals.length < size * size * size * 3) throw new Error(`The LUT is incomplete (${vals.length / 3} of ${size ** 3} entries).`);
  const N = size;
  const data = new Uint8Array(N * N * N * 4);
  const to8 = (v: number, c: number) => Math.max(0, Math.min(255, Math.round(((v - min[c]) / (max[c] - min[c] || 1)) * 255)));
  // .cube order: red changes fastest, then green, then blue.
  for (let b = 0; b < N; b++)
    for (let g = 0; g < N; g++)
      for (let r = 0; r < N; r++) {
        const i = (r + g * N + b * N * N) * 3;
        const o = (g * N * N + b * N + r) * 4;
        data[o] = to8(vals[i], 0);
        data[o + 1] = to8(vals[i + 1], 1);
        data[o + 2] = to8(vals[i + 2], 2);
        data[o + 3] = 255;
      }
  return { size: N, data, title };
}

/** Load (once) and cache the LUT at a path. */
export function loadLut(path: string): Promise<Lut> {
  const have = cache.get(path);
  if (have) return Promise.resolve(have);
  let p = loading.get(path);
  if (!p) {
    p = api.readFile(path).then((f) => {
      const lut = parseCube(new TextDecoder().decode(f.data), f.name.replace(/\.cube$/i, ''));
      cache.set(path, lut);
      loading.delete(path);
      for (const cb of listeners) cb();
      return lut;
    });
    p.catch(() => loading.delete(path));
    loading.set(path, p);
  }
  return p;
}

/** Load every LUT a project uses (before an export, so every frame has its LUT). */
export async function preloadLuts(p: Project) {
  const paths = [...new Set(p.clips.map((c) => c.lut?.path).filter(Boolean) as string[])];
  await Promise.all(paths.map((x) => loadLut(x).catch(() => null)));
}

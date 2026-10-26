// What a practice exam is made of: the student's mix of question kinds (Settings → Scholar → Practice questions, under
// Advanced), applied to what the chosen chapters actually have.
import { useSettings } from './settings';

export const MIX_KINDS = ['mc', 'blank', 'match', 'multi', 'num', 'tf', 'short'] as const;

/** Each kind's weight (0 leaves it out). */
export function studyMix(): Record<string, number> {
  const v = useSettings.getState().values;
  return Object.fromEntries(MIX_KINDS.map((k) => [k, Math.max(0, Number(v[`study.mix.${k}`] ?? 1) || 0)]));
}

/**
 * `n` of `items` (in the order they should be asked first: missed, then new, then the rest), each kind's share as
 * close to the mix as the items allow. A kind with too few is made up from the others, in order; a kind weighted 0 is
 * left out unless nothing else is there.
 */
export function pickByMix<T extends { type: string }>(items: T[], n: number, mix = studyMix()): T[] {
  const allowed = items.filter((i) => (mix[i.type] ?? 1) > 0);
  const pool = allowed.length ? allowed : items;
  const want = Math.min(n, pool.length);
  const byKind = new Map<string, T[]>();
  for (const it of pool) byKind.set(it.type, [...(byKind.get(it.type) || []), it]);
  const kinds = [...byKind.keys()];
  const total = kinds.reduce((t, k) => t + (mix[k] ?? 1), 0) || 1;
  // Whole shares first, then the leftover places to the kinds with the largest remainders.
  const exact = kinds.map((k) => ({ k, x: (want * (mix[k] ?? 1)) / total }));
  const quota = new Map(exact.map(({ k, x }) => [k, Math.min(Math.floor(x), byKind.get(k)!.length)]));
  let left = want - [...quota.values()].reduce((a, b) => a + b, 0);
  for (const { k } of [...exact].sort((a, b) => (b.x % 1) - (a.x % 1))) {
    if (left <= 0) break;
    if (quota.get(k)! < byKind.get(k)!.length) (quota.set(k, quota.get(k)! + 1), left--);
  }
  const chosen = new Set<T>();
  for (const k of kinds) byKind.get(k)!.slice(0, quota.get(k)).forEach((it) => chosen.add(it));
  // (Kinds that ran short: the rest of the places go to whatever comes next.)
  for (const it of pool) {
    if (chosen.size >= want) break;
    chosen.add(it);
  }
  return pool.filter((it) => chosen.has(it));
}

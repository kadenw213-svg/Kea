// What a practice exam is made of: the student's mix of question kinds (Settings → Scholar → Practice questions, under
// Advanced), applied to what the chosen chapters actually have.
import { useSettings } from './settings';
import { pickByMixWith } from './studyQueue';

export const MIX_KINDS = ['mc', 'blank', 'match', 'multi', 'num', 'tf', 'short'] as const;

/** Each kind's weight (0 leaves it out). */
export function studyMix(): Record<string, number> {
  const v = useSettings.getState().values;
  return Object.fromEntries(MIX_KINDS.map((k) => [k, Math.max(0, Number(v[`study.mix.${k}`] ?? 1) || 0)]));
}

/**
 * `n` of `items` (in the order they should be asked first: missed, then new, then the rest), each kind's share as
 * close to the mix as the items allow. A kind with too few is made up from the others, in order; a kind weighted 0 is
 * left out unless nothing else is there. (The rule itself is in studyQueue.ts, shared with the Study stream.)
 */
export function pickByMix<T extends { type: string }>(items: T[], n: number, mix = studyMix()): T[] {
  return pickByMixWith(items, n, mix);
}

/** The Study stream's settings (Settings → Scholar → Studying, under Advanced). */
export function streamSettings() {
  const v = useSettings.getState().values;
  const num = (k: string, d: number) => (Number.isFinite(Number(v[k])) && v[k] !== '' && v[k] != null ? Number(v[k]) : d);
  return { missGap: num('study.stream.missGap', 4), reviewShare: num('study.stream.reviewShare', 0.25), learnedAt: num('study.stream.learnedAt', 80), sound: !!v['study.sound'] };
}

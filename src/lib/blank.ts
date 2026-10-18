// Marking a fill-in-the-blank answer (a word or two) the way a teacher would: spelling slips, capitals, plurals,
// "the", Greek letters typed out and subscripts typed as plain digits all still count. Kea's own matching decides
// first; only an answer it can't place is put to the local model, which can only say "same answer" or "different".
import { api, AiEvent } from './api';

const SUB = '₀₁₂₃₄₅₆₇₈₉';
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const GREEK: Record<string, string> = { α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', Δ: 'delta', λ: 'lambda', μ: 'mu', π: 'pi', σ: 'sigma', ω: 'omega' };

/** An answer reduced to what matters: lower case, no accents, punctuation, articles or plural endings. */
export function normalize(s: string) {
  return String(s || '')
    .replace(/[₀-₉]/g, (c) => String(SUB.indexOf(c)))
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => String(SUP.indexOf(c)))
    .replace(/[αβγδΔλμπσω]/g, (c) => ` ${GREEK[c]} `)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]s/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9+\-]+/g, ' ')
    .split(' ')
    .filter((w) => w && !['a', 'an', 'the'].includes(w))
    .map((w) => (w.length > 4 && /ies$/.test(w) ? w.replace(/ies$/, 'y') : w.length > 4 && /(s|x|z|ch|sh)es$/.test(w) ? w.slice(0, -2) : w.length > 3 && /[^su]s$/.test(w) ? w.slice(0, -1) : w))
    .join(' ');
}

function distance(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // A swapped pair of letters is one slip.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/** Right by Kea's own matching: the same after normalizing, or a typo away (1 slip from 4 letters, 2 from 9). */
export function matches(given: string, answers: string[]) {
  const g = normalize(given);
  if (!g) return false;
  return answers.some((a) => {
    const n = normalize(a);
    if (!n) return false;
    if (n === g || n.replace(/ /g, '') === g.replace(/ /g, '')) return true;
    // Numbers and symbols must be exact (H2O vs H2O2, 12 vs 13).
    if (/\d/.test(n) || /\d/.test(g)) return false;
    // Typos keep a word's start: a different first letter is a different word, and two slips need the first three
    // letters right (so exothermic never passes for endothermic).
    if (n[0] !== g[0]) return false;
    const slips = n.length >= 9 && n.slice(0, 3) === g.slice(0, 3) ? 2 : n.length >= 4 ? 1 : 0;
    return slips > 0 && distance(n, g) <= slips;
  });
}

async function modelReady() {
  const st = await api.ai.state().catch(() => null);
  return !!st?.models.find((m) => m.tier === st.settings.tier)?.installed;
}

const cache = new Map<string, boolean>();

/**
 * Whether a blank was filled in right. Kea's matching first; otherwise the local model, if one is downloaded, judges
 * whether it's the same answer in other words (a synonym, an abbreviation, a symbol for a name). Without one, false.
 */
export async function judgeBlank(given: string, answer: string, accept: string[], question: string): Promise<boolean> {
  const answers = [answer, ...accept];
  if (matches(given, answers)) return true;
  if (!normalize(given)) return false;
  const key = `${question}\u0000${normalize(given)}`;
  if (cache.has(key)) return cache.get(key)!;
  let ok = false;
  if (await modelReady()) {
    try {
      const id = await api.ai.generate({
        system: 'You mark fill-in-the-blank answers for a class. A student answer counts when it means the same thing as the correct answer in this question: a synonym, an abbreviation, a symbol for a name, another spelling. A different term, a related but different idea, or a vaguer word does not count. Reply only with the JSON.',
        prompt: `Question: ${question}\nCorrect answer: ${answers.join(' / ')}\nStudent answer: ${given}\n\n1 = the student's answer is the same answer\n2 = it is a different answer`,
        jsonSchema: { type: 'object', properties: { verdict: { type: 'integer', enum: [1, 2] } }, required: ['verdict'] },
        temperature: 0,
        maxTokens: 16
      });
      const text = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => (off(), api.ai.stop(id), reject(new Error('slow'))), 30000);
        const off = api.ai.onEvent((e: AiEvent) => {
          if (e.id !== id || e.type === 'token') return;
          clearTimeout(timer);
          off();
          if (e.type === 'done') resolve(e.text);
          else reject(new Error(e.message));
        });
      });
      ok = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}').verdict === 1;
    } catch {}
  }
  cache.set(key, ok);
  return ok;
}

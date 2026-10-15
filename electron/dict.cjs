// Look up → Dictionary: an offline English dictionary from WordNet 3.1 (Princeton University). Definitions, example
// sentences, synonyms and antonyms, read straight from WordNet's own files; nothing leaves this PC.
const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');

const DIR = require('wordnet-db').path;
const FILES = { n: 'noun', v: 'verb', a: 'adj', r: 'adv' };
const POS_NAME = { n: 'noun', v: 'verb', a: 'adjective', s: 'adjective', r: 'adverb' };

// index.<pos>: lemma → synset offsets (WordNet lists them most common sense first). Loaded on first use.
const indexes = {};
function index(pos) {
  if (!indexes[pos]) {
    const m = new Map();
    for (const line of fs.readFileSync(path.join(DIR, `index.${FILES[pos]}`), 'utf8').split('\n')) {
      if (!line || line[0] === ' ') continue;
      const f = line.trim().split(' ');
      const pCnt = +f[3];
      const senseCnt = +f[4 + pCnt];
      // How often the word was seen in this part of speech in WordNet's tagged texts (to list the commonest first).
      m.set(f[0], { offsets: f.slice(f.length - senseCnt).map(Number), tagged: +f[5 + pCnt] || 0 });
    }
    indexes[pos] = m;
  }
  return indexes[pos];
}

// data.<pos>: one synset per line, found by its byte offset.
const fds = {};
function readSynset(pos, offset) {
  const file = FILES[pos === 's' ? 'a' : pos];
  fds[file] ??= fs.openSync(path.join(DIR, `data.${file}`), 'r');
  let text = '';
  for (let at = offset; !text.includes('\n'); at += 4096) {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fds[file], buf, 0, 4096, at);
    if (!n) break;
    text += buf.toString('utf8', 0, n);
  }
  const [body, gloss = ''] = text.split('\n')[0].split(' | ');
  const f = body.trim().split(' ');
  const type = f[2];
  const wCnt = parseInt(f[3], 16);
  const words = [];
  for (let i = 0; i < wCnt; i++) words.push(f[4 + i * 2].replace(/\(.*\)$/, '').replace(/_/g, ' '));
  let k = 4 + wCnt * 2;
  const pCnt = +f[k++];
  const ptrs = [];
  for (let i = 0; i < pCnt; i++, k += 4) ptrs.push({ sym: f[k], offset: +f[k + 1], pos: f[k + 2], src: parseInt(f[k + 3].slice(0, 2), 16), dst: parseInt(f[k + 3].slice(2), 16) });
  return { type, words, ptrs, gloss: gloss.trim() };
}

// Base forms ("ran" → "run", "studies" → "study"): WordNet's detachment rules plus common irregular forms.
const RULES = {
  n: [['s', ''], ['ses', 's'], ['xes', 'x'], ['zes', 'z'], ['ches', 'ch'], ['shes', 'sh'], ['men', 'man'], ['ies', 'y']],
  v: [['s', ''], ['ies', 'y'], ['es', 'e'], ['es', ''], ['ed', 'e'], ['ed', ''], ['ing', 'e'], ['ing', '']],
  a: [['er', ''], ['est', ''], ['er', 'e'], ['est', 'e'], ['ier', 'y'], ['iest', 'y']],
  r: []
};
const IRREGULAR_V = {
  went: 'go', gone: 'go', was: 'be', were: 'be', been: 'be', is: 'be', are: 'be', am: 'be', had: 'have', has: 'have', did: 'do', done: 'do', said: 'say', made: 'make',
  took: 'take', taken: 'take', came: 'come', saw: 'see', seen: 'see', knew: 'know', known: 'know', got: 'get', gotten: 'get', gave: 'give', given: 'give', found: 'find',
  thought: 'think', told: 'tell', became: 'become', left: 'leave', felt: 'feel', brought: 'bring', began: 'begin', begun: 'begin', kept: 'keep', held: 'hold', wrote: 'write',
  written: 'write', stood: 'stand', heard: 'hear', meant: 'mean', met: 'meet', ran: 'run', paid: 'pay', sat: 'sit', spoke: 'speak', spoken: 'speak', led: 'lead', grew: 'grow',
  grown: 'grow', lost: 'lose', fell: 'fall', fallen: 'fall', sent: 'send', built: 'build', understood: 'understand', drew: 'draw', drawn: 'draw', broke: 'break', broken: 'break',
  spent: 'spend', rose: 'rise', risen: 'rise', drove: 'drive', driven: 'drive', bought: 'buy', wore: 'wear', worn: 'wear', chose: 'choose', chosen: 'choose', sought: 'seek',
  threw: 'throw', thrown: 'throw', caught: 'catch', dealt: 'deal', won: 'win', fought: 'fight', taught: 'teach', ate: 'eat', eaten: 'eat', flew: 'fly', flown: 'fly', froze: 'freeze',
  frozen: 'freeze', hid: 'hide', hidden: 'hide', shook: 'shake', shaken: 'shake', sang: 'sing', sung: 'sing', swam: 'swim', swum: 'swim', bore: 'bear', borne: 'bear', born: 'bear'
};
const IRREGULAR_N = {
  children: 'child', men: 'man', women: 'woman', people: 'person', mice: 'mouse', geese: 'goose', feet: 'foot', teeth: 'tooth', data: 'datum', criteria: 'criterion',
  phenomena: 'phenomenon', analyses: 'analysis', theses: 'thesis', hypotheses: 'hypothesis', bacteria: 'bacterium', nuclei: 'nucleus', fungi: 'fungus', stimuli: 'stimulus'
};
const IRREGULAR_A = {
  better: 'good', best: 'good', worse: 'bad', worst: 'bad', further: 'far', farther: 'far', more: 'much', most: 'much', less: 'little', least: 'little'
};
function baseForms(word, pos) {
  const out = [word];
  const irr = { n: IRREGULAR_N, v: IRREGULAR_V, a: IRREGULAR_A, r: {} }[pos][word];
  if (irr) out.push(irr);
  for (const [suf, rep] of RULES[pos]) if (word.endsWith(suf) && word.length > suf.length + 1) out.push(word.slice(0, -suf.length) + rep);
  return [...new Set(out)];
}

/** Everything WordNet knows about a word, grouped by part of speech. Null when it isn't in the dictionary. */
function define(input, maxSenses = 6) {
  const word = String(input || '').trim().toLowerCase().replace(/[“”"'’.,;:!?()]/g, '').replace(/\s+/g, '_');
  if (!word || word.length > 60) return null;
  const entries = [];
  const synonyms = new Set();
  const antonyms = new Set();
  const display = word.replace(/_/g, ' ');
  for (const pos of ['n', 'v', 'a', 'r']) {
    const idx = index(pos);
    const lemma = baseForms(word, pos).find((w) => idx.has(w));
    if (!lemma) continue;
    const lemmaText = lemma.replace(/_/g, ' ');
    const senses = [];
    for (const offset of idx.get(lemma).offsets.slice(0, maxSenses)) {
      const s = readSynset(pos, offset);
      const parts = s.gloss.split(/;\s*(?=")/);
      const def = parts[0].replace(/;\s*$/, '').trim();
      const examples = parts.slice(1).map((e) => e.replace(/^"|"\s*;?\s*$/g, '').replace(/"$/, '').trim()).filter(Boolean);
      const syn = s.words.filter((w) => w.toLowerCase() !== lemmaText);
      syn.forEach((w) => synonyms.add(w));
      // Antonyms: direct ones on this word; for "satellite" adjectives (like "wet" ~ "damp"), those of the head word.
      const me = s.words.findIndex((w) => w.toLowerCase() === lemmaText) + 1;
      const ant = [];
      for (const p of s.ptrs.filter((p) => p.sym === '!' && (p.src === 0 || p.src === me))) {
        const t = readSynset(p.pos, p.offset);
        ant.push(...(p.dst ? [t.words[p.dst - 1]] : t.words));
      }
      if (s.type === 's') {
        for (const p of s.ptrs.filter((p) => p.sym === '&')) {
          const head = readSynset('a', p.offset);
          for (const q of head.ptrs.filter((q) => q.sym === '!')) {
            const t = readSynset(q.pos, q.offset);
            ant.push(...(q.dst ? [t.words[q.dst - 1]] : t.words));
          }
        }
      }
      ant.filter(Boolean).forEach((w) => antonyms.add(w));
      senses.push({ def, examples, synonyms: syn.slice(0, 8), antonyms: [...new Set(ant.filter(Boolean))].slice(0, 6) });
    }
    entries.push({ pos: POS_NAME[pos], lemma: lemmaText, senses, tagged: idx.get(lemma).tagged, count: idx.get(lemma).offsets.length });
  }
  if (!entries.length) return null;
  // Parts of speech where the word itself is listed come before ones reached through a base form.
  entries.sort((a, b) => Number(b.lemma === display) - Number(a.lemma === display) || b.tagged - a.tagged || b.count - a.count);
  entries.forEach((e) => (delete e.tagged, delete e.count));
  return { word: display, entries, synonyms: [...synonyms].slice(0, 24), antonyms: [...antonyms].slice(0, 16) };
}

function register() {
  ipcMain.handle('lookup:define', (_e, word, maxSenses) => define(word, Math.max(1, Math.min(20, Number(maxSenses) || 6))));
}

module.exports = { register, define };

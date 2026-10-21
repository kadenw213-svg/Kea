// Listen: a deck read aloud, hands-free, for studying on a walk, in the car or in bed. Each card's question, a pause to
// think of the answer, the answer, a pause, the next card. Everything about it is a setting (speed, both pauses, which
// side first, repeats, which cards, shuffle, loop, the choices, the explanation), changed here or in Settings. On the
// phone it plays through Kea's reader, so it keeps going with the screen off; on the computer, with its own voices.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, Settings2, SkipBack, SkipForward, Square } from 'lucide-react';
import type { StudyCard, StudySetFull } from '../../lib/api';
import { useSetting, useSettings } from '../../lib/settings';
import { MathText } from './MathText';

type Item = { id: string; text: string; pause: number };
type Progress = { id: string; state: 'playing' | 'paused' | 'stopped' | 'done' | 'error' };
/** What plays the items: the phone's reader, or the computer's speech. */
interface Engine {
  start(items: Item[], o: { title: string; rate: number; loop: boolean; voice: string }): void;
  control(action: 'pause' | 'resume' | 'stop' | 'skip', by?: number): void;
  subscribe(cb: (p: Progress) => void): () => void;
}

// ---------- The computer's own voices ----------
function speechEngine(): Engine {
  let items: Item[] = [];
  let i = 0;
  let playing = false;
  let opts = { rate: 1, loop: false, voice: '' };
  let timer: any = null;
  let run = 0;
  const subs = new Set<(p: Progress) => void>();
  const emit = (state: Progress['state']) => subs.forEach((f) => f({ id: items[i]?.id || '', state }));
  const clear = () => {
    clearTimeout(timer);
    run++;
    try {
      speechSynthesis.cancel();
    } catch {}
  };
  const say = () => {
    if (!playing) return;
    if (i >= items.length) {
      if (!opts.loop || !items.length) return (playing = false), emit('done');
      i = 0;
    }
    const mine = ++run;
    const it = items[i];
    const u = new SpeechSynthesisUtterance(it.text);
    u.rate = opts.rate;
    const v = opts.voice && speechSynthesis.getVoices().find((x) => x.name === opts.voice);
    if (v) u.voice = v;
    u.onend = () => {
      if (mine !== run) return;
      timer = setTimeout(() => {
        if (mine !== run) return;
        i++;
        say();
      }, it.pause);
    };
    emit('playing');
    speechSynthesis.speak(u);
  };
  return {
    start(list, o) {
      clear();
      items = list;
      i = 0;
      opts = o;
      playing = true;
      say();
    },
    control(action, by = 1) {
      if (action === 'pause') (clear(), (playing = false), emit('paused'));
      else if (action === 'resume') ((playing = true), say());
      else if (action === 'stop') (clear(), (playing = false), emit('stopped'));
      else if (action === 'skip') {
        clear();
        i = Math.max(0, Math.min(items.length - 1, i + by));
        if (playing) say();
        else emit('paused');
      }
    },
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    }
  };
}
let engine: Engine | null = null;
// (Kea for Android puts its own in window.keaReadQueue.)
const getEngine = () => (engine = engine || (window as any).keaReadQueue || speechEngine());

const LETTERS = 'ABCDEFGH';
const SPEEDS = [0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];

/** The setting, and a way to change it (kept on this device, like every setting). */
function useOpt<T>(key: string): [T, (v: T) => void] {
  return [useSetting<T>(`study.listen.${key}`), (v: T) => useSettings.getState().set({ [`study.listen.${key}`]: v })];
}

export function Listen({ set }: { set: StudySetFull }) {
  const cards = set.cards || [];
  const [rate, setRate] = useOpt<number>('rate');
  const [gap, setGap] = useOpt<number>('gap');
  const [between, setBetween] = useOpt<number>('between');
  const [first, setFirst] = useOpt<'front' | 'back'>('first');
  const [repeat, setRepeat] = useOpt<number>('repeat');
  const [twice, setTwice] = useOpt<boolean>('repeatAnswer');
  const [which, setWhich] = useOpt<'all' | 'learning' | 'starred'>('which');
  const [shuffle, setShuffle] = useOpt<boolean>('shuffle');
  const [loop, setLoop] = useOpt<boolean>('loop');
  const [choices, setChoices] = useOpt<boolean>('choices');
  const [explain, setExplain] = useOpt<boolean>('explain');
  const [number, setNumber] = useOpt<boolean>('number');
  const [cue, setCue] = useOpt<boolean>('cue');
  const voice = useSetting<string>('study.listen.voice');
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState<Progress | null>(null);
  const [seed, setSeed] = useState(0);

  // The cards to read, in order.
  const deck = useMemo(() => {
    const known = new Set(set.known || []);
    const stars = new Set(set.starred || []);
    // (Choices in a fresh order, as in a practice exam: the saved order puts the answer first most of the time.)
    const mixed = (a: string[]) => {
      const b = [...a];
      for (let j = b.length - 1; j > 0; j--) {
        const r = Math.floor(Math.random() * (j + 1));
        [b[j], b[r]] = [b[r], b[j]];
      }
      return b;
    };
    let list = cards.map((c, i) => ({ c: c.choices?.length ? { ...c, choices: mixed(c.choices) } : c, i })).filter(({ c, i }) => (which === 'learning' ? !known.has(i) : which === 'starred' ? !!c.k && stars.has(c.k) : true));
    if (shuffle) {
      list = [...list];
      for (let j = list.length - 1; j > 0; j--) {
        const r = Math.floor(Math.random() * (j + 1));
        [list[j], list[r]] = [list[r], list[j]];
      }
    }
    return list;
  }, [cards, which, shuffle, seed]);

  // Each card as what's said and the pauses after.
  const items = useMemo(() => {
    const out: Item[] = [];
    deck.forEach(({ c }, n) => {
      const q = plain(c.front) + (choices && c.choices?.length ? '. ' + c.choices.map((x, j) => `${LETTERS[j]}: ${plain(x)}`).join('. ') : '');
      const ans = plain(c.back);
      const [one, two] = first === 'front' ? [q, ans] : [ans, q];
      const lead = cue ? (first === 'front' ? 'Answer: ' : 'Question: ') : '';
      const tail = explain && c.explain ? `. ${plain(c.explain)}` : '';
      for (let r = 0; r < Math.max(1, repeat); r++) {
        out.push({ id: `c${n}:q:${r}`, text: (number && r === 0 ? `Card ${n + 1}. ` : '') + one, pause: gap * 1000 });
        if (twice) {
          out.push({ id: `c${n}:a:${r}`, text: lead + two, pause: 800 });
          out.push({ id: `c${n}:a2:${r}`, text: two + tail, pause: between * 1000 });
        } else out.push({ id: `c${n}:a:${r}`, text: lead + two + tail, pause: between * 1000 });
      }
    });
    return out;
  }, [deck, gap, between, first, repeat, twice, choices, explain, number, cue]);

  const playingRef = useRef(false);
  useEffect(() => getEngine().subscribe((p) => (/^c\d+:/.test(p.id) || !p.id) && setNow(p)), []);
  useEffect(() => () => getEngine().control('stop'), []);
  const cardOf = (id: string) => Number(id.slice(1).split(':')[0]);
  const card = now?.id ? cardOf(now.id) : -1;
  const showing = card >= 0 ? deck[card]?.c : deck[0]?.c;
  const answerShown = !!now?.id && /:a/.test(now.id);
  const playing = now?.state === 'playing';
  playingRef.current = playing;

  const start = (fromCard = 0) => {
    const at = items.findIndex((it) => cardOf(it.id) >= fromCard);
    getEngine().start(items.slice(Math.max(0, at)), { title: set.title, rate, loop, voice });
    setNow({ id: items[Math.max(0, at)]?.id || '', state: 'playing' });
  };
  // A setting changed while it plays: carry on from this card with the new one.
  const first_ = useRef(true);
  useEffect(() => {
    if (first_.current) return void (first_.current = false);
    if (playingRef.current) start(Math.max(0, card));
  }, [items, rate, loop, voice]);
  const jump = (d: number) => {
    const target = Math.max(0, Math.min(deck.length - 1, (card < 0 ? 0 : card) + d));
    if (playing) start(target);
    else setNow({ id: `c${target}:q:0`, state: 'paused' });
  };

  if (!cards.length) return <div className="sch-empty">This set has no cards to listen to.</div>;
  return (
    <div className="st-cards ls">
      <div className="st-cards-bar">
        <span className="muted">
          {deck.length ? `Card ${Math.max(0, card) + 1} of ${deck.length}` : 'No cards match'} · {rate}× · {gap}s to think
        </span>
        <button className={`btn sm ${open ? 'tonal' : ''}`} onClick={() => setOpen(!open)}>
          <Settings2 size={13} /> Listening options
        </button>
      </div>
      {open && (
        <div className="ls-opts">
          <Opt label={`Speed: ${rate}×`}>
            {SPEEDS.map((r) => (
              <button key={r} className={`st-chip ${rate === r ? 'on' : ''}`} onClick={() => setRate(r)}>
                {r}×
              </button>
            ))}
            <input type="range" min={0.5} max={2.5} step={0.05} value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="Speed" />
          </Opt>
          <Opt label={`Pause before the answer: ${gap}s`}>
            <input type="range" min={0} max={30} step={0.5} value={gap} onChange={(e) => setGap(Number(e.target.value))} />
          </Opt>
          <Opt label={`Pause between cards: ${between}s`}>
            <input type="range" min={0} max={30} step={0.5} value={between} onChange={(e) => setBetween(Number(e.target.value))} />
          </Opt>
          <Opt label="Read first">
            <button className={`st-chip ${first === 'front' ? 'on' : ''}`} onClick={() => setFirst('front')}>
              Question
            </button>
            <button className={`st-chip ${first === 'back' ? 'on' : ''}`} onClick={() => setFirst('back')}>
              Answer
            </button>
          </Opt>
          <Opt label="Cards">
            {(
              [
                ['all', 'All'],
                ['learning', 'Still learning'],
                ['starred', 'Starred']
              ] as const
            ).map(([v, l]) => (
              <button key={v} className={`st-chip ${which === v ? 'on' : ''}`} onClick={() => setWhich(v)}>
                {l}
              </button>
            ))}
          </Opt>
          <Opt label="Read each card">
            {[1, 2, 3].map((n) => (
              <button key={n} className={`st-chip ${repeat === n ? 'on' : ''}`} onClick={() => setRepeat(n)}>
                {n === 1 ? 'Once' : `${n} times`}
              </button>
            ))}
          </Opt>
          <div className="ls-toggles">
            <Toggle on={shuffle} set={(v) => (setShuffle(v), setSeed(seed + 1))} label="Shuffle" />
            <Toggle on={loop} set={setLoop} label="Start again at the end" />
            <Toggle on={choices} set={setChoices} label="Read answer choices" />
            <Toggle on={explain} set={setExplain} label="Read the explanation" />
            <Toggle on={twice} set={setTwice} label="Say the answer twice" />
            <Toggle on={number} set={setNumber} label="Say the card number" />
            <Toggle on={cue} set={setCue} label="Say “Answer” first" />
          </div>
        </div>
      )}
      {showing ? (
        <div className={`st-card ls-card ${answerShown ? 'flipped' : ''}`}>
          <div className="st-card-side">
            <MathText text={showing.front} />
            {choices && showing.choices?.length ? (
              <ol className="ls-choices">
                {showing.choices.map((x, j) => (
                  <li key={j}>
                    <MathText text={x} />
                  </li>
                ))}
              </ol>
            ) : null}
            {answerShown && (
              <div className="ls-answer">
                <MathText text={showing.back} />
              </div>
            )}
          </div>
          <div className="muted st-card-foot">{!now ? 'Press play to listen' : now.state === 'paused' ? 'Paused' : answerShown ? 'Answer' : 'Think of the answer…'}</div>
        </div>
      ) : (
        <div className="sch-empty">No cards match these options.</div>
      )}
      <div className="st-cards-nav ls-nav">
        <button className="icon-btn" title="Previous card" onClick={() => jump(-1)}>
          <SkipBack size={18} />
        </button>
        <button className="btn primary ls-play" disabled={!items.length} onClick={() => (!now || now.state === 'stopped' || now.state === 'done' ? start(Math.max(0, card)) : getEngine().control(playing ? 'pause' : 'resume'))}>
          {playing ? <Pause size={18} /> : <Play size={18} />} {playing ? 'Pause' : now && now.state === 'paused' ? 'Resume' : 'Listen'}
        </button>
        <button className="icon-btn" title="Next card" onClick={() => jump(1)}>
          <SkipForward size={18} />
        </button>
        <button className="icon-btn" title="Stop" onClick={() => (getEngine().control('stop'), setNow(null))}>
          <Square size={16} />
        </button>
      </div>
    </div>
  );
}

function Opt({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ls-opt">
      <span className="hub-pick-label">{label}</span>
      <div className="ls-opt-row">{children}</div>
    </div>
  );
}
function Toggle({ on, set, label }: { on: boolean; set(v: boolean): void; label: string }) {
  return (
    <label className="ls-toggle">
      <input type="checkbox" checked={!!on} onChange={(e) => set(e.target.checked)} /> {label}
    </label>
  );
}

/** A card's text as it should be said: formulas' markup out, symbols as words. */
function plain(s: string) {
  return String(s || '')
    .replace(/\$+/g, '')
    .replace(/\\(frac)\{([^}]*)\}\{([^}]*)\}/g, '$2 over $3')
    .replace(/\^\(([^)]*)\)|\^\{([^}]*)\}|\^(-?\w+)/g, (_m, a, b, c) => ` to the ${a || b || c}`)
    .replace(/_\(([^)]*)\)|_\{([^}]*)\}|_(\w)/g, (_m, a, b, c) => ` ${a || b || c}`)
    .replace(/\\[a-z]+/gi, '')
    .replace(/→/g, ' gives ')
    .replace(/×/g, ' times ')
    .replace(/[{}]/g, '')
    .replace(/_{2,}/g, ' blank ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type { StudyCard };

// Reading on the phone: a chapter (or any PDF) full screen, made for a long read in bed or on the bus. Smooth scrolling
// that only draws the pages near the screen, the page remembered for next time, the page colour and size chosen, a tap
// to hide everything but the book. And read aloud like an audiobook: the phone's own voices (offline ones work with no
// signal), carrying on with the screen off, with speed, a sleep timer, and the next chapter after this one.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Gauge, Headphones, Moon, Pause, Play, Settings2, SkipBack, SkipForward, Square, Type, X } from 'lucide-react';
import { api } from '../../src/lib/api';
import { loadPdf, PDFDocumentProxy } from '../../src/editors/pdf/pdfjs';
import { Kea, PhoneVoice, cachedData } from './kea';
import { PAGES, PageId, isScan, pageFor, setLook, useLook } from './theme';
import { toast } from './ui';

export type BookTarget = { file: string; chapter: string; title: string; autoplay?: boolean };

// ---------- Where each book was left ----------
const PLACES = 'kea.books';
export type Place = { file: string; chapter: string; title: string; code?: string; page: number; pages: number; at: string; said?: string };
export function places(): Record<string, Place> {
  try {
    return JSON.parse(localStorage.getItem(PLACES) || '{}');
  } catch {
    return {};
  }
}
function savePlace(p: Place) {
  try {
    const all = places();
    all[p.file] = p;
    // (The 40 most recent books.)
    const keep = Object.values(all)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 40);
    localStorage.setItem(PLACES, JSON.stringify(Object.fromEntries(keep.map((x) => [x.file, x]))));
  } catch {}
}
/** The book read most recently, to carry on with. */
export const lastPlace = (): Place | null => Object.values(places()).sort((a, b) => b.at.localeCompare(a.at))[0] || null;

/** The class and the chapter after this one, from the PC's copy (for carrying on and for the title). */
function chapterInfo(file: string) {
  const d = cachedData();
  for (const c of d?.details || []) {
    const chs = c.chapters.filter((ch) => ch.pdf);
    const i = chs.findIndex((ch) => ch.pdf!.file === file);
    if (i >= 0) {
      const n = chs[i + 1];
      return { code: c.code, next: n ? { file: n.pdf!.file, chapter: n.label, title: n.title || n.label } : null };
    }
  }
  return { code: '', next: null };
}

// ---------- The book's words, as sentences to read ----------
/** Where on its page a sentence is: boxes as shares of the page's width and height, from the top left. */
type Box = [number, number, number, number];
type Sentence = { id: string; page: number; text: string; boxes: Box[] };
type Line = { text: string; x0: number; x1: number; top: number; bottom: number };
const texts = new Map<string, Promise<Sentence[]>>();
/** How a sentence is said: letter-spaced headings as words, numbers and symbols as they're meant. */
function spoken(t: string) {
  return (
    t
      // Letter-spaced headings ("C H E 1 0 1 1") as words, section numbers as numbers ("1. 1" → "1.1").
      .replace(/\b(?:[A-Za-z0-9] ){2,}[A-Za-z0-9]\b/g, (m) => m.replace(/ /g, ''))
      .replace(/(\d)\. (\d)/g, '$1.$2')
      .replace(/\s*→\s*/g, ' gives ')
      .replace(/\s*•\s*/g, '. ')
      // A power of ten loses its raised exponent in the text ("5 × 103"): said as it's meant.
      .replace(/× ?10([−-])?(\d{1,2})\b/g, (_m, minus, d) => `× 10 to the ${minus ? 'minus ' : ''}${d}`)
  );
}
/**
 * Every sentence of the book, in order, with its page and where it is on the page (for marking it while it's read);
 * running heads, footers, page numbers and the contents' dot leaders left out.
 */
function sentencesOf(file: string, pdf: PDFDocumentProxy) {
  if (!texts.has(file))
    texts.set(
      file,
      (async () => {
        const pages: Line[][] = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          const vp = page.getViewport({ scale: 1 });
          const tc = await page.getTextContent();
          const lines: Line[] = [];
          let cur: Line | null = null;
          for (const it of tc.items as any[]) {
            if (typeof it.str !== 'string') continue;
            if (it.str) {
              // (The item's box in page shares, top left origin.)
              const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
              const hgt = it.height || Math.hypot(it.transform[2], it.transform[3]);
              const box = { x0: x / vp.width, x1: (x + it.width) / vp.width, top: (y - hgt) / vp.height, bottom: (y + hgt * 0.25) / vp.height };
              if (!cur) cur = { text: '', ...box };
              cur.text += it.str;
              cur.x0 = Math.min(cur.x0, box.x0);
              cur.x1 = Math.max(cur.x1, box.x1);
              cur.top = Math.min(cur.top, box.top);
              cur.bottom = Math.max(cur.bottom, box.bottom);
            }
            if (it.hasEOL && cur) {
              cur.text = cur.text.trim();
              lines.push(cur);
              cur = null;
            }
          }
          if (cur && cur.text.trim()) lines.push({ ...cur, text: cur.text.trim() });
          pages.push(lines);
        }
        // A line on many pages is a running head or footer, not the text.
        const key = (l: string) => l.replace(/\d+/g, '#');
        const count = new Map<string, number>();
        for (const ls of pages) for (const l of new Set(ls.map((x) => key(x.text)))) count.set(l, (count.get(l) || 0) + 1);
        const repeated = (l: string) => pages.length >= 4 && (count.get(key(l)) || 0) >= Math.max(3, pages.length * 0.3);
        const out: Sentence[] = [];
        pages.forEach((all, p) => {
          // (Not read: page numbers, contents lines with their dot leaders, the running heads.)
          const ls = all.filter((l) => l.text && !/^[\divxlc.\s]+$/i.test(l.text) && !/(\.\s?){4,}/.test(l.text) && !/^contents$/i.test(l.text) && !repeated(l.text));
          // The page's text in one string, with where each line starts in it (a word split by a hyphen joined again).
          let raw = '';
          const at: { start: number; line: Line }[] = [];
          for (const l of ls) {
            if (/\w-$/.test(raw) && /^[a-z]/.test(l.text)) raw = raw.slice(0, -1);
            else if (raw) raw += ' ';
            at.push({ start: raw.length, line: l });
            raw += l.text;
          }
          // Sentences end at . ! or ? followed by a space and a new sentence (not inside 1.500, 1. 1 or e.g.).
          const cuts: [number, number][] = [];
          let from = 0;
          const end = /[.!?]["”’)\]]*\s+(?=[A-Z0-9“"(])/g;
          for (let m; (m = end.exec(raw)); ) {
            if (/\d\.$/.test(raw.slice(0, m.index + 1)) && /^\d/.test(raw.slice(m.index + m[0].length))) continue;
            cuts.push([from, m.index + m[0].trimEnd().length]);
            from = m.index + m[0].length;
          }
          if (from < raw.length) cuts.push([from, raw.length]);
          // Short pieces (an abbreviation, a heading) join the next one.
          const merged: [number, number][] = [];
          for (const c of cuts) {
            const last = merged[merged.length - 1];
            if (last && last[1] - last[0] < 30) last[1] = c[1];
            else merged.push([...c]);
          }
          merged.forEach(([a, b], i) => {
            const text = spoken(raw.slice(a, b).trim());
            if (!text) return;
            // The lines it touches: from its start to its end on each (the middle ones whole).
            const boxes: Box[] = [];
            at.forEach(({ start, line }, j) => {
              const stop = j + 1 < at.length ? at[j + 1].start : raw.length;
              if (stop <= a || start >= b) return;
              const span = Math.max(1, line.text.length);
              const w = line.x1 - line.x0;
              const s0 = Math.max(0, a - start) / span;
              const s1 = Math.min(span, b - start) / span;
              boxes.push([line.x0 + w * s0, line.top, w * (s1 - s0), line.bottom - line.top]);
            });
            out.push({ id: `${p}:${i}`, page: p, text, boxes });
          });
        });
        return out;
      })()
    );
  return texts.get(file)!;
}

// ---------- Pages ----------
function PageCanvas({ pdf, n, width, height }: { pdf: PDFDocumentProxy; n: number; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let task: any;
    let live = true;
    pdf.getPage(n + 1).then((page) => {
      const c = ref.current;
      if (!live || !c) return;
      const vp1 = page.getViewport({ scale: 1 });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale: (width / vp1.width) * dpr });
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
      task = page.render({ canvasContext: c.getContext('2d')!, viewport: vp, transform: [c.width / vp.width, 0, 0, c.height / vp.height, 0, 0] });
      task.promise.catch(() => {});
    });
    return () => {
      live = false;
      task?.cancel?.();
      if (ref.current) ref.current.width = ref.current.height = 0;
    };
  }, [pdf, n, width, height]);
  return <canvas ref={ref} />;
}

const SPEEDS = [0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
const SLEEPS = [0, 10, 15, 30, 45, 60];
const GAP = 10;

export function Book({ target, onClose, onOpen }: { target: BookTarget; onClose(): void; onOpen?(t: BookTarget): void }) {
  const look = useLook();
  const page = pageFor(look, target.file);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [ratio, setRatio] = useState(1.3);
  const [error, setError] = useState('');
  const [box, setBox] = useState(0);
  const [cur, setCur] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [chrome, setChrome] = useState(true);
  const [sheet, setSheet] = useState<'' | 'look' | 'voice' | 'sleep'>('');
  const scroller = useRef<HTMLDivElement>(null);
  const info = useMemo(() => chapterInfo(target.file), [target.file]);
  const saved = places()[target.file];

  useEffect(() => {
    let live = true;
    setPdf(null);
    setError('');
    api
      .readFile(target.file)
      .then((f) => loadPdf(f.data))
      .then(async (d) => {
        const vp = (await d.getPage(1)).getViewport({ scale: 1 });
        if (!live) return;
        setRatio(vp.height / vp.width);
        setPdf(d);
      })
      .catch((e: any) => live && setError(String(e?.message || 'Kea couldn’t open this book.')));
    return () => {
      live = false;
    };
  }, [target.file]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const w = Math.max(0, (box - 16) * zoom);
  const h = w * ratio;
  const n = pdf?.numPages || 0;
  // Back where it was left, once the pages have a size.
  const placed = useRef(false);
  useEffect(() => {
    if (!pdf || !w || placed.current) return;
    placed.current = true;
    if (saved?.page) scroller.current?.scrollTo({ top: saved.page * (h + GAP) });
  }, [pdf, w]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el || !h) return;
    const p = Math.min(n - 1, Math.max(0, Math.floor((el.scrollTop + el.clientHeight / 3) / (h + GAP))));
    if (p !== cur) setCur(p);
  };
  useEffect(() => {
    if (!pdf) return;
    savePlace({ file: target.file, chapter: target.chapter, title: target.title, code: info.code, page: cur, pages: n, at: new Date().toISOString(), said: places()[target.file]?.said });
  }, [cur, pdf]);
  const goPage = (p: number, smooth = false) => scroller.current?.scrollTo({ top: Math.max(0, p) * (h + GAP), behavior: smooth ? 'smooth' : 'auto' });

  // ---------- Reading aloud ----------
  const [speech, setSpeech] = useState<{ state: string; id: string; index: number; total: number } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [sentences, setSentences] = useState<Sentence[]>([]);
  const [sleepLeft, setSleepLeft] = useState(0);
  const mine = useRef(false);
  const said = useMemo(() => sentences.find((s) => s.id === speech?.id), [sentences, speech?.id]);
  useEffect(() => {
    const sub = Kea.addListener('speech', (p) => {
      // (A deck being listened to, or a document read aloud, has its own ids: c<card>:…, d<block>:…)
      if (!mine.current || /^[cd]/.test(p.id)) return;
      setSpeech(p);
      const s = p.id ? Number(p.id.split(':')[0]) : NaN;
      if (p.state === 'playing' && !Number.isNaN(s)) {
        const all = places()[target.file];
        if (all) savePlace({ ...all, said: p.id, at: new Date().toISOString() });
        if (getFollow()) followTo(s);
      }
      // The end of the chapter: on to the next one, still reading.
      if (p.state === 'done' && info.next && onOpen) onOpen({ ...info.next, autoplay: true });
    });
    return () => {
      sub.then((s) => s.remove());
      // (Leaving the book doesn't stop the reading: it plays on, with its notification.)
    };
  }, [target.file, h]);
  const followRef = useRef(look.follow);
  followRef.current = look.follow;
  const getFollow = () => followRef.current;
  const curRef = useRef(cur);
  curRef.current = cur;
  const followTo = (p: number) => p !== curRef.current && goPage(p, Math.abs(p - curRef.current) < 2);

  const start = async (from?: string) => {
    if (!pdf) return;
    setPreparing(true);
    try {
      const all = await sentencesOf(target.file, pdf);
      setSentences(all);
      if (!all.length) return toast('This book has no text to read aloud (it may be scanned pictures).');
      // From the sentence it stopped at, if that's on this page; otherwise from the top of this page.
      let i = from ? all.findIndex((s) => s.id === from) : -1;
      if (i < 0 && saved?.said && Number(saved.said.split(':')[0]) === cur) i = all.findIndex((s) => s.id === saved.said);
      if (i < 0) i = Math.max(0, all.findIndex((s) => s.page >= cur));
      mine.current = true;
      await Kea.readAloud({ items: all.slice(i).map(({ id, text }) => ({ id, text })), title: `${info.code ? info.code + ' · ' : ''}${target.title}`, voice: look.voice || undefined, rate: look.rate });
      setSpeech({ state: 'playing', id: all[i].id, index: 0, total: all.length - i });
    } catch (e: any) {
      toast(e?.message || 'Kea couldn’t start reading aloud.');
    } finally {
      setPreparing(false);
    }
  };
  // Opened to carry on from the chapter before: reading starts by itself.
  useEffect(() => {
    if (pdf && target.autoplay) start();
  }, [pdf]);
  // Already reading this book (opened again while it plays): show the player.
  useEffect(() => {
    Kea.readControl({ action: 'state' })
      .then((r) => {
        if (r.playing && places()[target.file]?.said === r.id) {
          mine.current = true;
          setSpeech({ state: 'playing', id: r.id, index: 0, total: 0 });
          setSleepLeft(r.sleepLeft);
          if (pdf) sentencesOf(target.file, pdf).then(setSentences);
        }
      })
      .catch(() => {});
  }, [pdf]);
  const control = async (action: 'pause' | 'resume' | 'stop' | 'skip', by?: number) => {
    const r = await Kea.readControl({ action, by }).catch(() => null);
    if (action === 'stop') setSpeech(null);
    else if (r) setSpeech((s) => (s ? { ...s, state: action === 'pause' ? 'paused' : r.playing ? 'playing' : s.state } : s));
  };
  const setRate = (rate: number) => {
    setLook({ rate });
    Kea.readControl({ action: 'settings', rate }).catch(() => {});
  };
  const sleep = async (minutes: number) => {
    const r = await Kea.readControl({ action: 'sleep', minutes }).catch(() => null);
    setSleepLeft(r?.sleepLeft || 0);
    setSheet('');
    toast(minutes ? `Reading stops in ${minutes} minutes.` : 'Sleep timer off.');
  };
  useEffect(() => {
    if (!sleepLeft) return;
    const t = setInterval(() => setSleepLeft((s) => Math.max(0, s - 30000)), 30000);
    return () => clearInterval(t);
  }, [sleepLeft > 0]);
  const playing = speech?.state === 'playing';
  const listening = !!speech && speech.state !== 'stopped' && speech.state !== 'done' && speech.state !== 'error';

  return (
    <div className={`m-overlay bk ${chrome ? '' : 'bk-bare'}`} style={{ ['--page-bg' as any]: page.bg || 'var(--surface-2)', ['--page-filter' as any]: page.filter || 'none' }}>
      {chrome && (
        <div className="bk-top">
          <button className="icon" aria-label="Back" onClick={onClose}>
            <ChevronLeft size={22} />
          </button>
          <span className="bk-title">
            <b>{target.title}</b>
            <span className="muted small block">
              {[info.code, target.chapter !== target.title ? target.chapter : '', n ? `Page ${cur + 1} of ${n}` : ''].filter(Boolean).join(' · ')}
            </span>
          </span>
          <button className="icon" aria-label="Page and colours" onClick={() => setSheet(sheet === 'look' ? '' : 'look')}>
            <Type size={20} />
          </button>
          <button className={`icon ${listening ? 'on' : ''}`} aria-label="Read aloud" disabled={!pdf || preparing} onClick={() => (listening ? control(playing ? 'pause' : 'resume') : start())}>
            <Headphones size={20} />
          </button>
        </div>
      )}
      <div className="bk-pages" ref={scroller} onScroll={onScroll} onClick={() => (sheet ? setSheet('') : setChrome(!chrome))}>
        {error ? (
          <p className="muted bk-msg">{error}</p>
        ) : !pdf || !w ? (
          <div className="spinner bk-msg" />
        ) : (
          Array.from({ length: n }, (_, i) => (
            <div key={i} className="bk-page" style={{ width: w, height: h }}>
              {Math.abs(i - cur) <= 2 && <PageCanvas pdf={pdf} n={i} width={w} height={h} />}
              {/* The sentence being read, marked on its page. */}
              {listening &&
                look.highlight !== 'off' &&
                said?.page === i &&
                said.boxes.map((b, k) => <i key={k} className={`bk-mark ${look.highlight}`} style={{ left: `${b[0] * 100}%`, top: `${b[1] * 100}%`, width: `${b[2] * 100}%`, height: `${b[3] * 100}%` }} />)}
            </div>
          ))
        )}
      </div>
      {chrome && !listening && n > 1 && (
        <div className="bk-scrub">
          <input type="range" min={0} max={n - 1} value={cur} onChange={(e) => goPage(Number(e.target.value))} aria-label="Page" />
          <span className="muted small">
            {cur + 1} / {n}
          </span>
        </div>
      )}
      {listening && (
        <div className="bk-player">
          <div className="bk-said">{said ? said.text : preparing ? 'Getting the chapter ready…' : speech?.state === 'paused' ? 'Paused' : 'Reading aloud…'}</div>
          <div className="bk-controls">
            <button className="icon" aria-label="Back a sentence" onClick={() => control('skip', -1)}>
              <SkipBack size={20} />
            </button>
            <button className="bk-play" aria-label={playing ? 'Pause' : 'Play'} onClick={() => control(playing ? 'pause' : 'resume')}>
              {playing ? <Pause size={24} /> : <Play size={24} />}
            </button>
            <button className="icon" aria-label="Forward a sentence" onClick={() => control('skip', 1)}>
              <SkipForward size={20} />
            </button>
            <button className="bk-chip" onClick={() => setRate(SPEEDS.find((r) => r > look.rate + 0.001) || SPEEDS[0])}>
              <Gauge size={14} /> {Math.round(look.rate * 100) / 100}×
            </button>
            <button className={`bk-chip ${sleepLeft ? 'on' : ''}`} onClick={() => setSheet(sheet === 'sleep' ? '' : 'sleep')}>
              <Moon size={14} /> {sleepLeft ? `${Math.ceil(sleepLeft / 60000)}m` : 'Sleep'}
            </button>
            <button className="icon" aria-label="Voice" onClick={() => setSheet(sheet === 'voice' ? '' : 'voice')}>
              <Settings2 size={18} />
            </button>
            <button className="icon" aria-label="Stop reading" onClick={() => control('stop')}>
              <Square size={16} />
            </button>
          </div>
        </div>
      )}
      {sheet === 'look' && <LookSheet zoom={zoom} setZoom={setZoom} scan={isScan(target.file)} onClose={() => setSheet('')} />}
      {sheet === 'voice' && <VoiceSheet onClose={() => setSheet('')} />}
      {sheet === 'sleep' && (
        <div className="bk-sheet">
          <div className="bk-sheet-head">
            <b>Stop reading after</b>
            <button className="icon" onClick={() => setSheet('')} aria-label="Close">
              <X size={18} />
            </button>
          </div>
          <div className="bk-opts">
            {SLEEPS.map((m) => (
              <button key={m} className="bk-chip" onClick={() => sleep(m)}>
                {m ? `${m} min` : 'Off'}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The page: its colour, its size, and following along while it's read. */
function LookSheet({ zoom, setZoom, scan, onClose }: { zoom: number; setZoom(z: number): void; scan: boolean; onClose(): void }) {
  const look = useLook();
  return (
    <div className="bk-sheet">
      <div className="bk-sheet-head">
        <b>Page</b>
        <button className="icon" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </div>
      {scan && (
        <label className="toggle">
          <input type="checkbox" checked={!!look.darkScans} onChange={(e) => setLook({ darkScans: e.target.checked })} /> Colour scans too (dark pages for scans)
        </label>
      )}
      <span className="muted small">Colour</span>
      <div className="bk-opts">
        {(Object.keys(PAGES) as PageId[]).map((id) => (
          <button key={id} className={`bk-swatch ${look.page === id ? 'on' : ''}`} onClick={() => setLook({ page: id })}>
            <i style={{ background: PAGES[id].bg || 'linear-gradient(135deg, var(--bg) 50%, var(--text) 50%)' }} />
            {PAGES[id].label}
          </button>
        ))}
      </div>
      <span className="muted small">Size</span>
      <div className="bk-opts">
        {[1, 1.25, 1.5, 2].map((z) => (
          <button key={z} className={`bk-chip ${zoom === z ? 'on' : ''}`} onClick={() => setZoom(z)}>
            {z === 1 ? 'Fit width' : `${Math.round(z * 100)}%`}
          </button>
        ))}
      </div>
      <span className="muted small">Mark the sentence being read</span>
      <div className="bk-opts">
        {(
          [
            ['fill', 'Highlight'],
            ['underline', 'Underline'],
            ['off', 'Off']
          ] as const
        ).map(([v, l]) => (
          <button key={v} className={`bk-chip ${look.highlight === v ? 'on' : ''}`} onClick={() => setLook({ highlight: v })}>
            {l}
          </button>
        ))}
      </div>
      <label className="toggle">
        <input type="checkbox" checked={look.follow} onChange={(e) => setLook({ follow: e.target.checked })} />
        <span>Turn the pages while reading aloud</span>
      </label>
    </div>
  );
}

/** The phone's voices: offline ones first (they keep reading with no signal), each with a sample to hear. */
export function VoiceSheet({ onClose }: { onClose(): void }) {
  const look = useLook();
  const [voices, setVoices] = useState<PhoneVoice[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    Kea.voices()
      .then((r) => setVoices(r.voices))
      .catch((e: any) => setError(String(e?.message || e)));
  }, []);
  const choose = (v: PhoneVoice) => {
    setLook({ voice: v.name });
    Kea.readControl({ action: 'settings', voice: v.name }).catch(() => {});
    Kea.say({ text: 'This is how this voice sounds when it reads your book.', voice: v.name, rate: look.rate }).catch(() => {});
  };
  const names = voiceNames(voices || []);
  return (
    <div className="bk-sheet bk-voices">
      <div className="bk-sheet-head">
        <b>Voice</b>
        <button className="icon" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </div>
      {error ? (
        <p className="note warn">{error}</p>
      ) : !voices ? (
        <div className="spinner" />
      ) : (
        <div className="bk-voice-list">
          {voices.slice(0, 16).map((v) => (
            <button key={v.name} className={`bk-voice ${(look.voice || voices.find((x) => x.isDefault)?.name) === v.name ? 'on' : ''}`} onClick={() => choose(v)}>
              <span>
                <b>{names.get(v.name)}</b>
                <span className="muted small block">
                  {[v.online ? 'Needs internet' : 'Works offline', v.quality >= 400 ? 'Natural' : ''].filter(Boolean).join(' · ')}
                </span>
              </span>
              <Play size={16} className="muted" />
            </button>
          ))}
        </div>
      )}
      <p className="muted small">More voices: Android Settings → Text-to-speech → Speech Services by Google → Install voice data.</p>
    </div>
  );
}

/** Plain names for voices ("US English · Voice 2"), numbered within each accent. */
function voiceNames(list: PhoneVoice[]) {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const v of list) {
    const where = v.country || v.locale;
    const k = `${where}|${v.online}`;
    const i = (seen.get(k) || 0) + 1;
    seen.set(k, i);
    out.set(v.name, `${where} · Voice ${i}${v.online ? ' (online)' : ''}`);
  }
  return out;
}

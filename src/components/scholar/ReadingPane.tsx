// The class textbook beside a practice exam or flashcards. The book icon opens it where the answer is: the question's
// section (named by the set, or matched from its topic), then the page and line in that section whose words best match
// the question and its answer, briefly highlighted. So the student can look the answer up without leaving the quiz.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { BookOpen, Moon, X } from 'lucide-react';
import { api } from '../../lib/api';
import { loadPdf, PDFDocumentProxy } from '../../editors/pdf/pdfjs';
import { findChapter, OutlineEntry, readOutline } from '../../lib/pdfTarget';
import { useSetting, useSettings } from '../../lib/settings';

export interface ReadingTarget {
  chapter: string;
  /** The textbook section that answers it ("5.1 The Gaseous State"). */
  section?: string | null;
  topic?: string | null;
  /** The question and its answer (or the card's two sides): the words to look for on the page. */
  query?: string;
  /** Opened by itself after a miss (not the student's click): shown only when Kea is sure it found the place. */
  auto?: boolean;
  /** Which question asked (the open icon is shown as on). */
  key?: string;
}

/** What the player offers its questions: which chapters have a textbook PDF, and a way to open one. */
export const ReadingContext = createContext<{ has(chapter?: string | null): boolean; open(t: ReadingTarget): void; current: ReadingTarget | null; course?(id: string): void }>({
  has: () => false,
  open: () => {},
  current: null
});

/**
 * Opens the reading where the answer is when the student gets one wrong (Settings → Scholar → "Open the reading when
 * you miss one"), so a miss turns straight into the part of the textbook that teaches it.
 */
export function useMissReading() {
  const r = useContext(ReadingContext);
  const on = useSetting<boolean>('scholar.autoReading') !== false;
  return (t: { chapter?: string | null; section?: string | null; topic?: string | null; query?: string; key?: string }) => {
    if (!on || !t.chapter || !r.has(t.chapter)) return;
    r.open({ chapter: t.chapter, section: t.section, topic: t.topic, query: t.query, key: t.key || `${t.chapter}|${t.section || ''}|${t.topic || ''}`, auto: true });
  };
}

/** The book icon on a question or card. */
export function ReadingButton({ chapter, section, topic, query, id }: { chapter?: string | null; section?: string | null; topic?: string | null; query?: string; id?: string }) {
  const r = useContext(ReadingContext);
  if (!chapter || !r.has(chapter)) return null;
  const key = id || `${chapter}|${section || ''}|${topic || ''}`;
  const on = r.current?.key === key;
  const where = section || topic;
  return (
    <button
      className={`icon-btn sm st-read-btn ${on ? 'on' : ''}`}
      title={`Read ${where ? `about ${where}` : chapter} beside the quiz`}
      onClick={(e) => {
        e.stopPropagation();
        r.open({ chapter, section, topic, query, key });
      }}
    >
      <BookOpen size={15} />
    </button>
  );
}

// ---------- Finding the place ----------
interface Book {
  pdf: PDFDocumentProxy;
  outline: OutlineEntry[];
  /** Each page's lines (text and height from the top, 0–1), read once when first searched. */
  lines: Map<number, Promise<{ text: string; y: number }[]>>;
}
// Loaded books stay open for the session: switching questions shouldn't reload a 40-page PDF.
const books = new Map<string, Promise<Book>>();
function book(file: string) {
  if (!books.has(file)) {
    const p = api.readFile(file).then(async (f) => {
      const pdf = await loadPdf(f.data);
      return { pdf, outline: await readOutline(pdf), lines: new Map() };
    });
    p.catch(() => books.delete(file));
    books.set(file, p);
  }
  return books.get(file)!;
}

function linesOf(b: Book, page: number) {
  if (!b.lines.has(page))
    b.lines.set(
      page,
      b.pdf.getPage(page + 1).then(async (p) => {
        const h = p.getViewport({ scale: 1 }).height;
        const tc = await p.getTextContent();
        // Text runs on the same baseline make one line.
        const rows = new Map<number, string[]>();
        for (const it of tc.items as any[]) {
          if (!it.str?.trim()) continue;
          const y = Math.round(it.transform[5]);
          rows.set(y, [...(rows.get(y) || []), it.str]);
        }
        return [...rows].map(([y, parts]) => ({ text: parts.join(' '), y: Math.max(0, Math.min(1, 1 - y / h)) }));
      })
    );
  return b.lines.get(page)!;
}

const STOP = new Set('the and for that this with from which what when where why how are was were has have had does did not but its into than then them they their there these those each also only such more most some many much very can will would should could about after before between under over your you our use used using following true false select apply correct answer chapter section'.split(' '));
// Words to match on: lower case, curly quotes straightened, possessives dropped ("Boyle’s law" → boyle, law).
const words = (s: string) =>
  (s.toLowerCase().replace(/[’‘]/g, "'").replace(/'s\b/g, '').match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || []).filter((w) => w.length >= 3 && !STOP.has(w));
const overlap = (want: string[], have: Set<string>) => want.filter((w) => have.has(w)).length / Math.max(1, want.length);

// `sure`: the place is the question's own section, a heading that names its topic, or a passage that clearly matches;
// otherwise it's a best guess (the chapter's or section's start).
type Spot = { page: number; y: number | null; sure?: boolean };
const before = (a: Spot, b: Spot) => a.page < b.page || (a.page === b.page && (a.y ?? 0) < (b.y ?? 0));

/**
 * Where to open the book for a question: { page, y } (y: 0–1 down the page, or null for the page's top).
 * 1. The chapter, from the book's outline.  2. Its section: the one the question names ("5.2 …", by number, then by
 * title).  3. A heading in it (or in the chapter) that matches the question's topic ("Vapor pressure, evaporation and
 * condensation"), at the heading's own place.  4. Otherwise the line in the section whose words best match the topic
 * and the question and answer, skipping the chapter's opening (its "on the exam" overview mentions everything).
 */
async function locate(b: Book, t: ReadingTarget): Promise<Spot> {
  const { outline } = b;
  const pages = b.pdf.numPages;
  const heights = new Map<number, number>();
  const spot = async (e: OutlineEntry): Promise<Spot> => {
    if (e.y == null) return { page: e.page, y: null };
    if (!heights.has(e.page)) heights.set(e.page, (await b.pdf.getPage(e.page + 1)).getViewport({ scale: 1 }).height);
    return { page: e.page, y: Math.max(0, Math.min(1, 1 - e.y / heights.get(e.page)!)) };
  };
  /** The entries under one (its sections, or a section's subsections), with the next one at its level. */
  const under = (e: OutlineEntry | null) => {
    const at = e ? outline.indexOf(e) : -1;
    const end = e ? outline.findIndex((x, i) => i > at && x.depth <= e.depth) : -1;
    return { inside: outline.slice(at + 1, end < 0 ? undefined : end).filter((x) => x.page >= 0), next: end < 0 ? null : outline[end] };
  };
  const ch = findChapter(outline, t.chapter);
  const chapter = under(ch);
  const sections = chapter.inside.filter((e) => e.depth === (ch ? ch.depth + 1 : 0));
  const num = t.section?.match(/^\s*(\d+(?:\.\d+)+)/)?.[1];
  let sec = (num && sections.find((e) => e.title.trim().startsWith(num) && !/\d/.test(e.title.trim().charAt(num.length)))) || null;
  if (!sec && t.section) {
    const want = words(t.section.replace(/^\s*[\d.]+\s*/, ''));
    sec = sections.map((e) => ({ e, v: overlap(want, new Set(words(e.title))) })).sort((a, b2) => b2.v - a.v).find((x) => x.v >= 0.5)?.e || null;
  }
  const area = sec ? under(sec) : chapter;
  const topic = words(t.topic || '');
  const query = words(t.query || '');
  // A heading that names the topic: the textbook's own place for it.
  const heading = area.inside
    .map((e) => {
      const have = new Set(words(e.title));
      return { e, topic: overlap(topic, have), v: overlap(topic, have) * 3 + overlap(query, have) };
    })
    .sort((a, b2) => b2.v - a.v)[0];
  if (heading && topic.length && heading.topic >= 0.5) return { ...(await spot(heading.e)), sure: true };
  // Otherwise search the text, from the section's start (or the chapter's first section) to the next one.
  const start: Spot = sec ? await spot(sec) : sections[0] ? await spot(sections[0]) : ch ? await spot(ch) : { page: 0, y: null };
  const end: Spot = area.next ? await spot(area.next) : { page: pages - 1, y: 1 };
  if (topic.length || query.length) {
    let best = { spot: start, score: 0 };
    for (let p = start.page; p <= Math.min(end.page, start.page + 40); p++) {
      const lines = await linesOf(b, p);
      for (let i = 0; i < lines.length; i++) {
        const here = { page: p, y: lines[i].y };
        if (before(here, start) || before(end, here)) continue;
        // A line and the two after it: definitions and worked steps run over several lines.
        const have = new Set(words(lines.slice(i, i + 3).map((l) => l.text).join(' ')));
        const score = overlap(topic, have) * 3 + overlap(query, have) * 2;
        if (score > best.score) best = { spot: here, score };
      }
    }
    // (A strong match: most of the topic's words and a good part of the question's, together in a few lines.)
    if (best.score >= 1) return { ...best.spot, sure: best.score >= 2.2 || (!!sec && !!num) };
  }
  // The section the question names, found by its number, is the right place even with no closer match in it.
  return { ...start, sure: !!sec && !!num };
}

// ---------- The pane ----------
/** One page, drawn when it scrolls into view. */
function Page({ pdf, n, width, ratio, root }: { pdf: PDFDocumentProxy; n: number; width: number; ratio: number; root: HTMLElement | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { root, rootMargin: '600px 0px' });
    io.observe(c);
    return () => io.disconnect();
  }, [root]);
  useEffect(() => {
    if (!seen || !width) return;
    let task: any;
    let live = true;
    pdf.getPage(n + 1).then((page) => {
      if (!live || !ref.current) return;
      const vp1 = page.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: (width / vp1.width) * dpr });
      const c = ref.current;
      // Exactly the pixels it covers on screen, so it isn't rescaled (and blurred).
      c.width = Math.round(width * dpr);
      c.height = Math.round(width * ratio * dpr);
      task = page.render({ canvasContext: c.getContext('2d')!, viewport: vp, transform: [c.width / vp.width, 0, 0, c.height / vp.height, 0, 0] });
      task.promise.catch(() => {});
    });
    return () => {
      live = false;
      task?.cancel?.();
    };
  }, [seen, width, pdf, n]);
  return <canvas ref={ref} data-page={n} className="rp-page" style={{ width, height: width * ratio }} />;
}

/** The side panel: the chapter's textbook, scrolled to where the question is answered. */
export function ReadingPane({ file, target, onClose }: { file: string; target: ReadingTarget; onClose(): void }) {
  const [doc, setDoc] = useState<(Book & { ratio: number }) | null>(null);
  const [error, setError] = useState('');
  const [width, setWidth] = useState(0);
  const [mark, setMark] = useState<{ top: number; at: number } | null>(null);
  // Dark pages, the same choice as Kea's PDF viewer (toggling here changes it there too).
  const dark = !!useSetting<boolean>('pdf.darkPages');
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    setDoc(null);
    setError('');
    book(file)
      .then(async (b) => {
        const vp = (await b.pdf.getPage(1)).getViewport({ scale: 1 });
        if (live) setDoc({ ...b, ratio: vp.height / vp.width });
      })
      .catch(() => live && setError('Kea couldn’t open this chapter’s textbook.'));
    return () => {
      live = false;
    };
  }, [file]);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - 24));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Go to the answer whenever a different question asks, and mark the line for a moment.
  useEffect(() => {
    if (!doc || !width || !scroller.current) return;
    let live = true;
    locate(doc, target).then(({ page, y, sure }) => {
      // Opened by itself after a miss, but Kea isn't sure where the book teaches it: the explanation under the question
      // is the better help, so the book closes again rather than show a page that may not answer it.
      if (live && target.auto && !sure) return onClose();
      const box = scroller.current;
      const el = box?.querySelector<HTMLElement>(`[data-page="${page}"]`);
      if (!live || !box || !el) return;
      const top = el.offsetTop + (y == null ? 0 : y * el.clientHeight);
      // Near: glide there. Far: jump (a long smooth scroll is slow and gets cut short as pages draw on the way).
      const to = Math.max(0, top - (y == null ? 12 : box.clientHeight * 0.3));
      box.scrollTo({ top: to, behavior: Math.abs(to - box.scrollTop) < box.clientHeight * 1.5 ? 'smooth' : 'auto' });
      if (y != null) setMark({ top: top - 18, at: Date.now() });
    });
    return () => {
      live = false;
    };
  }, [doc, width, target]);
  return (
    <aside className="st-reading">
      <div className="st-reading-head">
        <BookOpen size={15} />
        <span className="st-reading-title">
          {target.chapter}
          {target.section || target.topic ? <span className="muted"> · {target.section || target.topic}</span> : null}
        </span>
        <button className={`icon-btn sm ${dark ? 'active' : ''}`} title={dark ? 'Light pages' : 'Dark pages'} onClick={() => useSettings.getState().set({ 'pdf.darkPages': !dark })}>
          <Moon size={15} />
        </button>
        <button className="icon-btn sm" title="Close the reading" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className={`st-reading-pages ${dark ? 'dark' : ''}`} ref={scroller}>
        {error ? <p className="muted">{error}</p> : !doc ? <div className="spinner" /> : Array.from({ length: doc.pdf.numPages }, (_, i) => <Page key={i} pdf={doc.pdf} n={i} width={width} ratio={doc.ratio} root={scroller.current} />)}
        {mark && <div key={mark.at} className="rp-mark" style={{ top: mark.top, width }} />}
      </div>
    </aside>
  );
}

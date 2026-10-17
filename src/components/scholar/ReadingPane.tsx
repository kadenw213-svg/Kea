// The class textbook beside a practice exam or flashcards: opens at the question's chapter (and its section, when the
// question's topic names one), so the student can look the answer up without leaving the quiz.
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { BookOpen, X } from 'lucide-react';
import { api } from '../../lib/api';
import { loadPdf, PDFDocumentProxy } from '../../editors/pdf/pdfjs';
import { findChapter, OutlineEntry, readOutline } from '../../lib/pdfTarget';

export interface ReadingTarget {
  chapter: string;
  topic?: string | null;
}

/** What the player offers its questions: which chapters have a textbook PDF, and a way to open one. */
export const ReadingContext = createContext<{ has(chapter?: string | null): boolean; open(t: ReadingTarget): void; current: ReadingTarget | null }>({
  has: () => false,
  open: () => {},
  current: null
});

/** The book icon on a question or card. */
export function ReadingButton({ chapter, topic }: { chapter?: string | null; topic?: string | null }) {
  const r = useContext(ReadingContext);
  if (!chapter || !r.has(chapter)) return null;
  const on = r.current?.chapter === chapter && (r.current?.topic || null) === (topic || null);
  return (
    <button
      className={`icon-btn sm st-read-btn ${on ? 'on' : ''}`}
      title={`Read ${chapter}${topic ? `: ${topic}` : ''} beside the quiz`}
      onClick={(e) => {
        e.stopPropagation();
        r.open({ chapter, topic });
      }}
    >
      <BookOpen size={15} />
    </button>
  );
}

// Loaded books stay open for the session: switching questions shouldn't reload a 40-page PDF.
const books = new Map<string, Promise<{ pdf: PDFDocumentProxy; outline: OutlineEntry[] }>>();
function book(file: string) {
  if (!books.has(file)) {
    const p = api.readFile(file).then(async (f) => {
      const pdf = await loadPdf(f.data);
      return { pdf, outline: await readOutline(pdf) };
    });
    p.catch(() => books.delete(file));
    books.set(file, p);
  }
  return books.get(file)!;
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
/** The page for a chapter, or the section in it whose heading best matches the topic ("Boyle's law" → "5.2 Boyle's Law"). */
function pageFor(outline: OutlineEntry[], t: ReadingTarget) {
  const ch = findChapter(outline, t.chapter);
  if (!ch) return 0;
  if (!t.topic) return ch.page;
  const at = outline.indexOf(ch);
  const end = outline.findIndex((e, i) => i > at && e.depth <= ch.depth);
  const inside = outline.slice(at + 1, end < 0 ? undefined : end).filter((e) => e.page >= 0);
  const want = words(t.topic);
  let best: OutlineEntry | null = null;
  let score = 0;
  for (const e of inside) {
    const have = words(e.title);
    const s = [...want].filter((w) => have.has(w)).length / Math.max(1, want.size);
    if (s > score) (best = e), (score = s);
  }
  return best && score >= 0.5 ? best.page : ch.page;
}

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
      c.width = vp.width;
      c.height = vp.height;
      task = page.render({ canvasContext: c.getContext('2d')!, viewport: vp });
      task.promise.catch(() => {});
    });
    return () => {
      live = false;
      task?.cancel?.();
    };
  }, [seen, width, pdf, n]);
  return <canvas ref={ref} data-page={n} className="rp-page" style={{ width, height: width * ratio }} />;
}

/** The side panel: the chapter's textbook, scrolled to the right page. */
export function ReadingPane({ file, target, onClose }: { file: string; target: ReadingTarget; onClose(): void }) {
  const [doc, setDoc] = useState<{ pdf: PDFDocumentProxy; outline: OutlineEntry[]; ratio: number } | null>(null);
  const [error, setError] = useState('');
  const [width, setWidth] = useState(0);
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
  // Jump to the chapter (or section) whenever a different question asks for it.
  useEffect(() => {
    if (!doc || !width || !scroller.current) return;
    const page = pageFor(doc.outline, target);
    const el = scroller.current.querySelector<HTMLElement>(`[data-page="${page}"]`);
    if (el) scroller.current.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' });
  }, [doc, width, target]);
  return (
    <aside className="st-reading">
      <div className="st-reading-head">
        <BookOpen size={15} />
        <span className="st-reading-title">
          {target.chapter}
          {target.topic ? <span className="muted"> · {target.topic}</span> : null}
        </span>
        <button className="icon-btn sm" title="Close the reading" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="st-reading-pages" ref={scroller}>
        {error ? <p className="muted">{error}</p> : !doc ? <div className="spinner" /> : Array.from({ length: doc.pdf.numPages }, (_, i) => <Page key={i} pdf={doc.pdf} n={i} width={width} ratio={doc.ratio} root={scroller.current} />)}
      </div>
    </aside>
  );
}

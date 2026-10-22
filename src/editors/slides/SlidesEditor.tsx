import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Undo2,
  Redo2,
  Plus,
  Type,
  Square,
  Circle,
  Triangle,
  Minus,
  MoveUpRight,
  ImagePlus,
  Play,
  Save,
  MoreVertical,
  FileDown,
  Printer,
  Bold,
  Italic,
  Underline as UIcon,
  AlignLeft,
  AlignCenter,
  AlignRight,
  List,
  ListOrdered,
  Baseline,
  PaintBucket,
  PenLine,
  BringToFront,
  SendToBack,
  Trash2,
  Copy,
  Palette,
  ChevronLeft,
  ChevronRight,
  X,
  Shapes,
  StickyNote,
  RectangleHorizontal,
  Clapperboard
} from 'lucide-react';
import { Presenter } from './Presenter';
import type { Tab } from '../../store';
import { editorRegistry, setDirty, toast } from '../../store';
import { Deck, El, Slide, Transition, THEMES, Theme, layoutSlide, newDeck, cloneSlide, textEl } from './model';
import { SlideView, SLIDE_CSS } from './SlideView';
import { readPptx } from './pptxImport';
import { writePptx } from './pptxExport';
import { saveTabFile, exportFile, isSilentSave } from '../../lib/save';
import { extOf, baseName } from '../../lib/fileTypes';
import { uid, clamp, modKey, bytesToDataUrl, escapeHtml } from '../../lib/util';
import { api } from '../../lib/api';
import { mimeFor } from '../../lib/pdfTools';
import { MenuButton } from '../../components/Popover';
import { ColorPicker } from '../../components/ColorPicker';
import './slides.css';
import { LookupButton } from '../../components/lookup/LookupButton';
import { AssistantButton } from '../../components/assistant/AssistantPanel';
import { publishSelection } from '../../components/lookup/lookupStore';
import { proxyAi, AiHooks } from '../../store';

function useHistory<T>(initial: T) {
  const state = useRef(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const [, force] = useReducer((x) => x + 1, 0);
  return useMemo(
    () => ({
      get: () => state.current,
      begin() {
        past.current.push(state.current);
        if (past.current.length > 200) past.current.shift();
        future.current = [];
      },
      live(s: T) {
        state.current = s;
        force();
      },
      commit(s: T) {
        this.begin();
        this.live(s);
      },
      undo() {
        const p = past.current.pop();
        if (p === undefined) return false;
        future.current.push(state.current);
        state.current = p;
        force();
        return true;
      },
      redo() {
        const n = future.current.pop();
        if (n === undefined) return false;
        past.current.push(state.current);
        state.current = n;
        force();
        return true;
      },
      canUndo: () => past.current.length > 0,
      canRedo: () => future.current.length > 0
    }),
    []
  );
}

export default function SlidesEditor({ tab, active }: { tab: Tab; active: boolean }) {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    (async () => {
      try {
        setDeck(tab.data ? await readPptx(tab.data) : newDeck());
      } catch (err: any) {
        console.error(err);
        setError(err?.message || String(err));
      }
    })();
  }, []);
  if (error)
    return (
      <div className="center-fill">
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <h3 style={{ color: 'var(--text)', fontWeight: 500 }}>Couldn't open this presentation</h3>
          <p>{error}</p>
        </div>
      </div>
    );
  if (!deck)
    return (
      <div className="center-fill">
        <div className="spinner" />
      </div>
    );
  return <SlidesInner tab={tab} active={active} initial={deck} />;
}

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

function SlidesInner({ tab, active, initial }: { tab: Tab; active: boolean; initial: Deck }) {
  const h = useHistory<Deck>(initial);
  const deck = h.get();
  const [idx, setIdx] = useState(0);
  const slide = deck.slides[Math.min(idx, deck.slides.length - 1)];
  const [selId, setSelId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [presenting, setPresenting] = useState<number | null>(null);
  const [notesOpen, setNotesOpen] = useState(true);
  const stageRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement>(null);
  const textNode = useRef<HTMLDivElement | null>(null);
  const drag = useRef<any>(null);
  const clipboard = useRef<El | null>(null);
  const dragSlide = useRef<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const sel = slide.els.find((e) => e.id === selId) || null;
  const markDirty = () => setDirty(tab.id, true);

  // Fit the slide in the stage.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => setScale(Math.max(0.1, Math.min((el.clientWidth - 64) / deck.w, (el.clientHeight - 48) / deck.h)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [deck.w, deck.h, notesOpen]);

  // ---------- Mutations ----------
  const updateSlide = (fn: (s: Slide) => Slide, live = false) => {
    const d = h.get();
    const slides = d.slides.map((s, i) => (i === idx ? fn(s) : s));
    live ? h.live({ ...d, slides }) : h.commit({ ...d, slides });
    markDirty();
  };
  const updateEl = (id: string, patch: Partial<El>, live = false) => updateSlide((s) => ({ ...s, els: s.els.map((e) => (e.id === id ? { ...e, ...patch } : e)) }), live);
  const addEl = (el: El) => {
    updateSlide((s) => ({ ...s, els: [...s.els, el] }));
    setSelId(el.id);
  };

  // ---------- Text editing ----------
  const finishEditing = useCallback(() => {
    if (!editingId) return;
    const node = textNode.current;
    if (node) {
      const html = node.innerHTML;
      const cur = h.get().slides[idx]?.els.find((e) => e.id === editingId);
      if (cur && cur.html !== html) updateEl(editingId, { html });
    }
    setEditingId(null);
    textNode.current = null;
  }, [editingId, idx]);

  const textRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && node !== textNode.current) {
        const el = h.get().slides[idx]?.els.find((e) => e.id === editingId);
        node.innerHTML = el?.html || '<p><br></p>';
        textNode.current = node;
        requestAnimationFrame(() => {
          node.focus();
          // Placeholder-style text gets fully selected so typing replaces it.
          const range = document.createRange();
          range.selectNodeContents(node);
          const isPrompt = /Click to add/.test(node.textContent || '');
          if (!isPrompt) range.collapse(false);
          const s = window.getSelection()!;
          s.removeAllRanges();
          s.addRange(range);
        });
      }
    },
    [editingId, idx]
  );

  useEffect(() => {
    setSelId(null);
    setEditingId(null);
  }, [idx]);

  const exec = (cmd: string, value?: string) => {
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(cmd, false, value);
    textNode.current?.focus();
  };

  /** Apply formatting either to the selection (while typing) or to the whole box. */
  const format = (kind: 'bold' | 'italic' | 'underline' | 'align' | 'size' | 'color' | 'list' | 'olist', value?: any) => {
    if (editingId && textNode.current) {
      if (kind === 'bold' || kind === 'italic' || kind === 'underline') exec(kind);
      else if (kind === 'color') exec('foreColor', value);
      else if (kind === 'align') exec(value === 'center' ? 'justifyCenter' : value === 'right' ? 'justifyRight' : 'justifyLeft');
      else if (kind === 'list') exec('insertUnorderedList');
      else if (kind === 'olist') exec('insertOrderedList');
      else if (kind === 'size') {
        const s = window.getSelection();
        if (s && !s.isCollapsed) {
          exec('fontSize', '7');
          textNode.current.querySelectorAll<HTMLElement>('font[size="7"], span[style*="xxx-large"]').forEach((n) => {
            if (n.tagName === 'FONT') {
              const span = document.createElement('span');
              span.style.fontSize = `${value}px`;
              span.innerHTML = n.innerHTML;
              n.replaceWith(span);
            } else n.style.fontSize = `${value}px`;
          });
        } else if (selId) updateEl(selId, { size: value, html: stripStyle(textNode.current.innerHTML, 'font-size') });
      }
      return;
    }
    if (!sel || sel.html === undefined) return;
    const html = sel.html;
    switch (kind) {
      case 'size':
        updateEl(sel.id, { size: value, html: stripStyle(html, 'font-size') });
        break;
      case 'color':
        updateEl(sel.id, { color: value, html: stripStyle(html, 'color') });
        break;
      case 'align':
        updateEl(sel.id, { html: setAlign(html, value) });
        break;
      case 'bold':
      case 'italic':
      case 'underline': {
        const tag = kind === 'bold' ? 'b' : kind === 'italic' ? 'i' : 'u';
        updateEl(sel.id, { html: toggleWrap(html, tag) });
        break;
      }
      case 'list':
      case 'olist':
        updateEl(sel.id, { html: toggleList(html, kind === 'olist' ? 'ol' : 'ul') });
        break;
    }
  };

  // ---------- Pointer interactions ----------
  const toSlide = (e: { clientX: number; clientY: number }) => {
    const r = slideRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const onStageDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('.sv-text-inner[contenteditable="true"]')) return;
    const handle = t.dataset.handle;
    const pt = toSlide(e);
    if (handle && sel) {
      e.preventDefault();
      if (editingId) finishEditing();
      h.begin();
      drag.current = { mode: 'resize', handle, start: pt, orig: { ...sel } };
      return;
    }
    const elNode = t.closest('[data-el]') as HTMLElement | null;
    if (editingId) finishEditing();
    if (!elNode) {
      setSelId(null);
      return;
    }
    e.preventDefault();
    const id = elNode.dataset.el!;
    const el = slide.els.find((x) => x.id === id)!;
    setSelId(id);
    if (e.detail === 2 && el.html !== undefined) {
      setEditingId(id);
      return;
    }
    drag.current = { mode: 'move', start: pt, orig: { ...el }, moved: false };
  };

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d || !slideRef.current) return;
      const pt = toSlide(e);
      const dx = pt.x - d.start.x,
        dy = pt.y - d.start.y;
      if (d.mode === 'move') {
        if (!d.moved && Math.hypot(dx, dy) * scale < 3) return;
        if (!d.moved) {
          h.begin();
          d.moved = true;
        }
        let nx = d.orig.x + dx,
          ny = d.orig.y + dy;
        // Snap to slide centre and edges.
        const cx = nx + d.orig.w / 2,
          cy = ny + d.orig.h / 2;
        const snap = 6 / scale;
        if (Math.abs(cx - deck.w / 2) < snap) nx = deck.w / 2 - d.orig.w / 2;
        if (Math.abs(cy - deck.h / 2) < snap) ny = deck.h / 2 - d.orig.h / 2;
        if (Math.abs(nx) < snap) nx = 0;
        if (Math.abs(ny) < snap) ny = 0;
        if (Math.abs(nx + d.orig.w - deck.w) < snap) nx = deck.w - d.orig.w;
        if (Math.abs(ny + d.orig.h - deck.h) < snap) ny = deck.h - d.orig.h;
        d.guides = { v: Math.abs(nx + d.orig.w / 2 - deck.w / 2) < 0.5, h: Math.abs(ny + d.orig.h / 2 - deck.h / 2) < 0.5 };
        slideRef.current.dataset.guideV = d.guides.v ? '1' : '';
        slideRef.current.dataset.guideH = d.guides.h ? '1' : '';
        updateEl(d.orig.id, { x: nx, y: ny }, true);
      } else if (d.mode === 'resize') {
        const o: El = d.orig;
        let x1 = o.x,
          y1 = o.y,
          x2 = o.x + o.w,
          y2 = o.y + o.h;
        if (d.handle.includes('w')) x1 = Math.min(x2 - 8, o.x + dx);
        if (d.handle.includes('e')) x2 = Math.max(x1 + 8, o.x + o.w + dx);
        if (d.handle.includes('n')) y1 = Math.min(y2 - 8, o.y + dy);
        if (d.handle.includes('s')) y2 = Math.max(y1 + 8, o.y + o.h + dy);
        let w = x2 - x1,
          hh = y2 - y1;
        if ((o.type === 'image') !== e.shiftKey && d.handle.length === 2) {
          const ratio = o.w / o.h;
          if (w / hh > ratio) w = hh * ratio;
          else hh = w / ratio;
          if (d.handle.includes('w')) x1 = x2 - w;
          if (d.handle.includes('n')) y1 = y2 - hh;
        }
        updateEl(o.id, { x: x1, y: y1, w, h: hh }, true);
      }
    };
    const up = () => {
      if (slideRef.current) {
        slideRef.current.dataset.guideV = '';
        slideRef.current.dataset.guideH = '';
      }
      drag.current = null;
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  });

  // ---------- Inserting ----------
  const center = (w: number, hh: number) => ({ x: (deck.w - w) / 2, y: (deck.h - hh) / 2, w, h: hh });
  const insertText = () => {
    const el = textEl({ ...center(deck.w * 0.5, 60), size: 24, color: guessTextColor(slide.bg), html: '<p>Text</p>' });
    addEl(el);
    setEditingId(el.id);
  };
  const insertShape = (shape: El['shape']) => {
    const line = shape === 'line' || shape === 'arrow';
    const accent = guessAccent(slide.bg);
    addEl({
      id: uid(),
      type: 'shape',
      shape,
      ...center(line ? 240 : 200, line ? 0.1 : 140),
      fill: line ? null : accent,
      stroke: line ? guessTextColor(slide.bg) : null,
      strokeW: line ? 2.5 : 0,
      html: line ? undefined : undefined
    });
  };
  const insertImage = async () => {
    const [f] = await api.openDialog({ title: 'Insert image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }] });
    if (!f) return;
    const src = await bytesToDataUrl(f.data, mimeFor(f.name));
    const img = new Image();
    img.src = src;
    await img.decode().catch(() => {});
    const ratio = (img.naturalHeight || 3) / (img.naturalWidth || 4);
    let w = Math.min(deck.w * 0.6, img.naturalWidth || 400);
    let hh = w * ratio;
    if (hh > deck.h * 0.7) {
      hh = deck.h * 0.7;
      w = hh / ratio;
    }
    addEl({ id: uid(), type: 'image', src, ...center(w, hh) });
  };
  const newSlide = (kind: 'title' | 'content' | 'section' | 'blank' | 'two') => {
    const theme = themeFromSlide(slide);
    const s = layoutSlide(kind, theme, deck.w, deck.h);
    const d = h.get();
    const slides = [...d.slides];
    slides.splice(idx + 1, 0, s);
    h.commit({ ...d, slides });
    markDirty();
    setIdx(idx + 1);
  };
  const applyTheme = (t: Theme) => {
    const d = h.get();
    h.commit({
      ...d,
      font: t.font,
      slides: d.slides.map((s) => ({
        ...s,
        bg: t.bg,
        els: s.els.map((e) =>
          e.locked
            ? e
            : e.html !== undefined
              ? { ...e, color: e.role === 'title' ? t.title : t.text, font: t.font, html: stripStyle(stripStyle(e.html, 'color'), 'font-family') }
              : e.type === 'shape' && e.fill
                ? { ...e, fill: t.accent }
                : e
        )
      }))
    });
    markDirty();
  };

  // ---------- Slides panel ----------
  const deleteSlide = (i: number) => {
    const d = h.get();
    if (d.slides.length === 1) return toast('A presentation needs at least one slide', 'error');
    h.commit({ ...d, slides: d.slides.filter((_, j) => j !== i) });
    markDirty();
    setIdx((x) => Math.max(0, Math.min(x, d.slides.length - 2)));
  };
  const duplicateSlide = (i: number) => {
    const d = h.get();
    const slides = [...d.slides];
    slides.splice(i + 1, 0, cloneSlide(d.slides[i]));
    h.commit({ ...d, slides });
    markDirty();
    setIdx(i + 1);
  };
  const moveSlide = (from: number, to: number) => {
    const d = h.get();
    if (to === from || to === from + 1) return;
    const slides = [...d.slides];
    const [s] = slides.splice(from, 1);
    slides.splice(to > from ? to - 1 : to, 0, s);
    h.commit({ ...d, slides });
    markDirty();
    setIdx(to > from ? to - 1 : to);
  };

  // ---------- Save / export ----------
  const staticHtml = () => {
    const d = h.get();
    const pages = d.slides
      .map((s) => `<div class="pg">${renderToStaticMarkup(<SlideView slide={s} w={d.w} h={d.h} font={d.font} />)}</div>`)
      .join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(baseName(tab.name))}</title><style>@page{size:${d.w / 72}in ${d.h / 72}in;margin:0}html,body{margin:0;padding:0}.pg{width:${d.w}px;height:${d.h}px;overflow:hidden;break-after:page;page-break-after:always;zoom:${96 / 72}}.pg:last-child{break-after:auto;page-break-after:auto}${SLIDE_CSS}</style></head><body>${pages}</body></html>`;
  };
  const save = async (saveAs: boolean) => {
    if (editingId && isSilentSave()) return false;
    if (editingId) finishEditing();
    return saveTabFile(tab.id, [{ name: 'PowerPoint presentation', ext: 'pptx', build: () => writePptx(h.get()) }], saveAs || (!!tab.path && extOf(tab.path) !== 'pptx'));
  };
  const exportPdf = () => exportFile(`${baseName(tab.name)}.pdf`, { name: 'PDF', ext: 'pdf', build: () => api.pdfFromHtml(staticHtml()) });
  const print = async () => {
    await api.printHtml(staticHtml());
  };
  const aiRef = useRef<AiHooks>(null as any);
  // The Claude Assistant's slide tools. Titles are one line; bodies are lines of text, each a bullet.
  const titleHtml = (t: string, center = false) => `<p${center ? ' style="text-align:center"' : ''}><b>${escapeHtml(t)}</b></p>`;
  const bodyHtml = (lines: string[]) => `<ul>${lines.map((l) => `<li>${escapeHtml(String(l).replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>`).join('')}</ul>`;
  const slideAt = (n: number) => {
    const d = h.get();
    if (!Number.isInteger(n) || n < 1 || n > d.slides.length) throw new Error(`There's no slide ${n}; the deck has ${d.slides.length}.`);
    return n - 1;
  };
  const fill = (sl: Slide, p: { title?: string; body?: string[]; notes?: string }): Slide => {
    const els = sl.els.map((e) => {
      if (p.title !== undefined && e.role === 'title') return { ...e, html: titleHtml(p.title, /text-align:center/.test(e.html || '')) };
      if (p.body !== undefined && (e.role === 'body' || e.role === 'subtitle')) return { ...e, html: e.role === 'subtitle' ? `<p style="text-align:center">${escapeHtml(p.body.join(' '))}</p>` : bodyHtml(p.body) };
      return e;
    });
    // Two body boxes (two columns): the lines split between them.
    const bodies = els.filter((e) => e.role === 'body');
    if (p.body && bodies.length === 2) {
      const half = Math.ceil(p.body.length / 2);
      bodies[0].html = bodyHtml(p.body.slice(0, half));
      bodies[1].html = bodyHtml(p.body.slice(half));
    }
    return { ...sl, els, ...(p.notes !== undefined ? { notes: p.notes } : {}) };
  };
  aiRef.current = {
    noun: 'presentation',
    insertLabel: 'Add to slide',
    tools: [
      {
        name: 'add_slide',
        description: 'Add a slide after slide `after` (default: the slide shown), in the deck\u2019s theme. Layouts: "title" (title + subtitle), "content" (title + bullets), "two" (title + two bullet columns), "section" (a section header), "blank".',
        input_schema: {
          type: 'object',
          properties: {
            layout: { type: 'string', enum: ['title', 'content', 'two', 'section', 'blank'] },
            title: { type: 'string' },
            body: { type: 'array', items: { type: 'string' }, description: 'Bullet lines (or the subtitle, for a title slide)' },
            notes: { type: 'string', description: 'Speaker notes' },
            after: { type: 'integer', description: 'Slide number to add it after' }
          },
          required: ['layout']
        },
        run: ({ layout, title, body, notes, after }) => {
          const d = h.get();
          const at = after === undefined ? idx : slideAt(after);
          const made = fill(layoutSlide(layout, themeFromSlide(d.slides[at] || slide), deck.w, deck.h), { title, body, notes });
          const slides = [...d.slides];
          slides.splice(at + 1, 0, made);
          h.commit({ ...d, slides });
          markDirty();
          setIdx(at + 1);
          return `Added slide ${at + 2}.`;
        }
      },
      {
        name: 'set_slide',
        description: 'Change a slide\u2019s title, body bullets or speaker notes (only the parts you give). Use read_document to see the current text first.',
        input_schema: {
          type: 'object',
          properties: { slide: { type: 'integer', description: 'Slide number, from 1' }, title: { type: 'string' }, body: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } },
          required: ['slide']
        },
        run: ({ slide: n, title, body, notes }) => {
          const i = slideAt(n);
          const d = h.get();
          const slides = [...d.slides];
          slides[i] = fill(slides[i], { title, body, notes });
          h.commit({ ...d, slides });
          markDirty();
          setIdx(i);
          return `Updated slide ${n}.`;
        }
      },
      {
        name: 'delete_slide',
        description: 'Delete a slide.',
        input_schema: { type: 'object', properties: { slide: { type: 'integer' } }, required: ['slide'] },
        run: ({ slide: n }) => {
          const i = slideAt(n);
          const d = h.get();
          if (d.slides.length === 1) throw new Error('A deck needs at least one slide.');
          h.commit({ ...d, slides: d.slides.filter((_, j) => j !== i) });
          markDirty();
          setIdx(Math.max(0, Math.min(i, d.slides.length - 2)));
          return `Deleted slide ${n}.`;
        }
      },
      {
        name: 'move_slide',
        description: 'Move a slide to a new position.',
        input_schema: { type: 'object', properties: { slide: { type: 'integer' }, to: { type: 'integer' } }, required: ['slide', 'to'] },
        run: ({ slide: n, to }) => {
          const i = slideAt(n);
          const j = slideAt(to);
          const d = h.get();
          const slides = [...d.slides];
          const [moved] = slides.splice(i, 1);
          slides.splice(j, 0, moved);
          h.commit({ ...d, slides });
          markDirty();
          setIdx(j);
          return `Moved slide ${n} to ${to}.`;
        }
      },
      {
        name: 'go_to_slide',
        description: 'Show a slide to the student (and to yourself, with look).',
        input_schema: { type: 'object', properties: { slide: { type: 'integer' } }, required: ['slide'] },
        run: ({ slide: n }) => {
          setIdx(slideAt(n));
          return `Showing slide ${n}.`;
        }
      }
    ],
    async getDocument() {
      const d = h.get();
      const sections = d.slides.map((s, i) => {
        const texts = s.els.filter((e) => e.html && !e.locked).sort((a, b) => (a.role === 'title' ? -1 : b.role === 'title' ? 1 : a.y - b.y)).map((e) => htmlText(e.html!));
        return { id: s.id, label: `Slide ${i + 1}`, text: `Slide ${i + 1}:\n${texts.join('\n')}${s.notes ? `\nSpeaker notes: ${s.notes}` : ''}` };
      });
      return { full: sections.map((x) => x.text).join('\n\n'), sections };
    },
    insertText(text) {
      const plain = text.replace(/\*\*/g, '');
      if (editingId && textNode.current) {
        textNode.current.focus();
        document.execCommand('insertText', false, plain);
        return true;
      }
      const lines = plain.split('\n').filter((l) => l.trim());
      const isList = lines.length > 1 && lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l));
      const html = isList
        ? `<ul>${lines.map((l) => `<li>${escapeHtml(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>`).join('')}</ul>`
        : lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('');
      const el = textEl({ x: deck.w * 0.1, y: deck.h * 0.25, w: deck.w * 0.8, h: deck.h * 0.6, size: 20, color: guessTextColor(slide.bg), html });
      addEl(el);
      return true;
    },
    replaceSelection(text) {
      const plain = text.replace(/\*\*/g, '');
      const s = window.getSelection();
      if (editingId && textNode.current && s && !s.isCollapsed) {
        document.execCommand('insertText', false, plain);
        return true;
      }
      if (sel && sel.html !== undefined) {
        updateEl(sel.id, { html: plain.split('\n').filter((l) => l.trim()).map((l) => `<p>${escapeHtml(l)}</p>`).join('') });
        return true;
      }
      return false;
    },
    reveal(quote) {
      const q = quote.replace(/[“”"]/g, '').trim().toLowerCase().slice(0, 40);
      const i = h.get().slides.findIndex((s) => s.els.some((e) => e.html && htmlText(e.html).toLowerCase().includes(q)) || s.notes.toLowerCase().includes(q));
      if (i < 0) return false;
      setIdx(i);
      return true;
    }
  };
  const handlers = useRef({ save, print });
  handlers.current = { save, print };
  useEffect(() => {
    editorRegistry.set(tab.id, { save: (a) => handlers.current.save(a), print: () => handlers.current.print(), debugBuild: () => writePptx(h.get()), ai: proxyAi(aiRef) });
  }, [tab.id]);

  // Report highlighted text (while editing) or the selected box's text to the AI sidebar.
  useEffect(() => {
    if (!active) return;
    const onSel = () => {
      const s = window.getSelection();
      if (s && !s.isCollapsed && textNode.current && s.anchorNode && textNode.current.contains(s.anchorNode)) publishSelection(tab.id, s.toString());
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, [active]);
  useEffect(() => {
    if (sel?.html && !editingId) publishSelection(tab.id, htmlText(sel.html));
  }, [selId]);

  // ---------- Keyboard ----------
  useEffect(() => {
    if (!active || presenting !== null) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA';
      const mod = modKey(e);
      const k = e.key.toLowerCase();
      if (e.key === 'F5') {
        e.preventDefault();
        if (editingId) finishEditing();
        setPresenting(e.shiftKey ? idx : 0);
        return;
      }
      if (typing) {
        if (e.key === 'Escape' && editingId) {
          e.preventDefault();
          finishEditing();
        }
        return;
      }
      if (mod && k === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (h.undo()) markDirty();
      } else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) {
        e.preventDefault();
        if (h.redo()) markDirty();
      } else if (mod && k === 'm') {
        e.preventDefault();
        newSlide('content');
      } else if (sel && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        updateSlide((s) => ({ ...s, els: s.els.filter((x) => x.id !== sel.id) }));
        setSelId(null);
      } else if (sel && mod && k === 'd') {
        e.preventDefault();
        addEl({ ...sel, id: uid(), x: sel.x + 16, y: sel.y + 16 });
      } else if (sel && mod && k === 'c') {
        clipboard.current = sel;
      } else if (clipboard.current && mod && k === 'v') {
        e.preventDefault();
        addEl({ ...clipboard.current, id: uid(), x: clipboard.current.x + 16, y: clipboard.current.y + 16 });
      } else if (sel && e.key === 'Enter' && sel.html !== undefined) {
        e.preventDefault();
        setEditingId(sel.id);
      } else if (sel && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        updateEl(sel.id, {
          x: sel.x + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0),
          y: sel.y + (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0)
        });
      } else if (!sel && (e.key === 'ArrowDown' || e.key === 'PageDown')) {
        e.preventDefault();
        setIdx((i) => Math.min(deck.slides.length - 1, i + 1));
      } else if (!sel && (e.key === 'ArrowUp' || e.key === 'PageUp')) {
        e.preventDefault();
        setIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Escape') setSelId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const isText = !!sel && sel.html !== undefined;
  const canFill = !!sel && sel.type !== 'image' && sel.shape !== 'line' && sel.shape !== 'arrow';
  const B = ({ on, title, onClick, children, disabled }: any) => (
    <button className={`icon-btn ${on ? 'active' : ''}`} title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
  const thumbW = 168;
  const thumbScale = thumbW / deck.w;

  return (
    <div className="slides-editor">
      <div className="toolbar">
        <B title="Undo (Ctrl+Z)" onClick={() => h.undo() && markDirty()} disabled={!h.canUndo()}>
          <Undo2 size={18} />
        </B>
        <B title="Redo (Ctrl+Y)" onClick={() => h.redo() && markDirty()} disabled={!h.canRedo()}>
          <Redo2 size={18} />
        </B>
        <div className="tb-sep" />
        <MenuButton title="New slide (Ctrl+M)" button={(open) => <button className={`btn tonal sm ${open ? 'on' : ''}`} style={{ marginRight: 4 }}><Plus size={16} /> Slide</button>}>
          {(close) => (
            <>
              <div className="menu-title">Layout</div>
              {(
                [
                  ['title', 'Title slide'],
                  ['content', 'Title and content'],
                  ['two', 'Two columns'],
                  ['section', 'Section header'],
                  ['blank', 'Blank']
                ] as const
              ).map(([k, label]) => (
                <button key={k} className="menu-item" onClick={() => (newSlide(k), close())}>
                  <RectangleHorizontal size={16} /> {label}
                </button>
              ))}
            </>
          )}
        </MenuButton>
        <B title="Text box" onClick={insertText}>
          <Type size={18} />
        </B>
        <MenuButton title="Shapes" button={(open) => <button className={`icon-btn ${open ? 'active' : ''}`}><Shapes size={18} /></button>}>
          {(close) => (
            <>
              <button className="menu-item" onClick={() => (insertShape('rect'), close())}>
                <Square size={16} /> Rectangle
              </button>
              <button className="menu-item" onClick={() => (insertShape('roundRect'), close())}>
                <RectangleHorizontal size={16} /> Rounded rectangle
              </button>
              <button className="menu-item" onClick={() => (insertShape('ellipse'), close())}>
                <Circle size={16} /> Ellipse
              </button>
              <button className="menu-item" onClick={() => (insertShape('triangle'), close())}>
                <Triangle size={16} /> Triangle
              </button>
              <button className="menu-item" onClick={() => (insertShape('line'), close())}>
                <Minus size={16} /> Line
              </button>
              <button className="menu-item" onClick={() => (insertShape('arrow'), close())}>
                <MoveUpRight size={16} /> Arrow
              </button>
            </>
          )}
        </MenuButton>
        <B title="Image" onClick={insertImage}>
          <ImagePlus size={18} />
        </B>
        <div className="tb-sep" />
        {isText && (
          <>
            <select className="select" style={{ width: 64 }} value={Math.round(sel!.size || 18)} onChange={(e) => format('size', Number(e.target.value))} title="Font size">
              {[10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 72, 96].concat(sel!.size && ![10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 72, 96].includes(Math.round(sel!.size)) ? [Math.round(sel!.size)] : []).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <B title="Bold" onClick={() => format('bold')}>
              <Bold size={18} />
            </B>
            <B title="Italic" onClick={() => format('italic')}>
              <Italic size={18} />
            </B>
            <B title="Underline" onClick={() => format('underline')}>
              <UIcon size={18} />
            </B>
            <ColorPicker title="Text color" icon={<Baseline size={18} />} value={sel!.color || null} onChange={(c) => c && format('color', c)} />
            <B title="Align left" onClick={() => format('align', 'left')}>
              <AlignLeft size={18} />
            </B>
            <B title="Center" onClick={() => format('align', 'center')}>
              <AlignCenter size={18} />
            </B>
            <B title="Align right" onClick={() => format('align', 'right')}>
              <AlignRight size={18} />
            </B>
            <B title="Bullets" onClick={() => format('list')}>
              <List size={18} />
            </B>
            <B title="Numbering" onClick={() => format('olist')}>
              <ListOrdered size={18} />
            </B>
            <div className="tb-sep" />
          </>
        )}
        {canFill && <ColorPicker title="Fill" icon={<PaintBucket size={18} />} value={sel!.fill || null} allowNone noneLabel="No fill" onChange={(c) => updateEl(sel!.id, { fill: c })} />}
        {sel && sel.type !== 'image' && (
          <ColorPicker
            title="Outline"
            icon={<PenLine size={18} />}
            value={sel.stroke || null}
            allowNone
            noneLabel="No outline"
            onChange={(c) => updateEl(sel.id, { stroke: c, strokeW: c ? sel.strokeW || 1.5 : 0 })}
          />
        )}
        {sel && (
          <>
            <B title="Bring to front" onClick={() => updateSlide((s) => ({ ...s, els: [...s.els.filter((x) => x.id !== sel.id), sel] }))}>
              <BringToFront size={18} />
            </B>
            <B title="Send to back" onClick={() => updateSlide((s) => ({ ...s, els: [...s.els.filter((x) => x.locked), sel, ...s.els.filter((x) => !x.locked && x.id !== sel.id)] }))}>
              <SendToBack size={18} />
            </B>
            <B title="Delete (Del)" onClick={() => (updateSlide((s) => ({ ...s, els: s.els.filter((x) => x.id !== sel.id) })), setSelId(null))}>
              <Trash2 size={18} />
            </B>
          </>
        )}
        {!sel && (
          <>
            <ColorPicker title="Slide background" icon={<PaintBucket size={18} />} value={slide.bg} onChange={(c) => c && updateSlide((s) => ({ ...s, bg: c }))} />
            <MenuButton title="Theme" button={(open) => <button className={`icon-btn ${open ? 'active' : ''}`}><Palette size={18} /></button>}>
              {(close) => (
                <div className="theme-grid">
                  {THEMES.map((t) => (
                    <button key={t.name} className="theme-swatch" style={{ background: t.bg, color: t.title, fontFamily: t.font }} onClick={() => (applyTheme(t), close())}>
                      <span style={{ fontWeight: 600 }}>Aa</span>
                      <i style={{ background: t.accent }} />
                      <small style={{ color: t.text }}>{t.name}</small>
                    </button>
                  ))}
                </div>
              )}
            </MenuButton>
          </>
        )}
        <div className="tb-spacer" />
        <MenuButton
          title="Transition"
          button={(open) => (
            <button className={`icon-btn ${open || (slide.transition && slide.transition.type !== 'none') ? 'active' : ''}`} title="Transition">
              <Clapperboard size={18} />
            </button>
          )}
        >
          {(close) => {
            const cur = slide.transition || { type: 'none' as const, duration: 0.5 };
            const setT = (t: Transition, all = false) => {
              const d = h.get();
              h.commit({ ...d, slides: d.slides.map((x, k) => (all || k === idx ? { ...x, transition: t.type === 'none' ? undefined : t } : x)) });
              markDirty();
            };
            return (
              <div style={{ minWidth: 220 }}>
                <div className="menu-title">Transition into this slide</div>
                {(['none', 'fade', 'push', 'wipe', 'cover', 'zoom'] as const).map((type) => (
                  <button key={type} className="menu-item" onClick={() => setT({ ...cur, type })}>
                    <span style={{ width: 14 }}>{cur.type === type ? '✓' : ''}</span> {type === 'none' ? 'None' : type[0].toUpperCase() + type.slice(1)}
                  </button>
                ))}
                <div className="menu-sep" />
                <div className="menu-title">Speed</div>
                {(
                  [
                    [0.3, 'Fast'],
                    [0.5, 'Medium'],
                    [0.9, 'Slow']
                  ] as const
                ).map(([d, label]) => (
                  <button key={label} className="menu-item" disabled={cur.type === 'none'} onClick={() => setT({ ...cur, duration: d })}>
                    <span style={{ width: 14 }}>{cur.type !== 'none' && Math.abs(cur.duration - d) < 0.05 ? '✓' : ''}</span> {label}
                  </button>
                ))}
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => (setT(cur, true), close())}>
                  Apply to all slides
                </button>
              </div>
            );
          }}
        </MenuButton>
        <B on={notesOpen} title="Speaker notes" onClick={() => setNotesOpen((o) => !o)}>
          <StickyNote size={18} />
        </B>
        <div className="tb-end">
        <button className="btn tonal sm" onClick={() => (finishEditing(), setPresenting(idx))} title="Present from this slide (Shift+F5) — F5 from start">
          <Play size={15} /> Present
        </button>
        <LookupButton />
        <AssistantButton />
        <button className="btn primary sm" onMouseDown={(e) => e.preventDefault()} onClick={() => save(false)} title="Save (Ctrl+S)">
          <Save size={16} /> Save
        </button>
        <MenuButton
          align="right"
          button={() => (
            <button className="icon-btn" title="More">
              <MoreVertical size={18} />
            </button>
          )}
        >
          {(close) => (
            <>
              <button className="menu-item" onClick={() => (save(true), close())}>
                <Save size={16} /> Save as… <span className="kbd">Ctrl+Shift+S</span>
              </button>
              <button className="menu-item" onClick={() => (exportPdf(), close())}>
                <FileDown size={16} /> Export as PDF…
              </button>
              <button className="menu-item" onClick={() => (print(), close())}>
                <Printer size={16} /> Print… <span className="kbd">Ctrl+P</span>
              </button>
            </>
          )}
        </MenuButton>
        </div>
      </div>

      <div className="slides-body">
        <div className="slide-list" onDragLeave={(e) => e.currentTarget === e.target && setDropAt(null)}>
          {deck.slides.map((s, i) => (
            <div
              key={s.id}
              className={`slide-thumb ${i === idx ? 'active' : ''} ${dropAt === i ? 'drop-before' : ''} ${dropAt === i + 1 && i === deck.slides.length - 1 ? 'drop-after' : ''}`}
              draggable
              onDragStart={() => (dragSlide.current = i)}
              onDragOver={(e) => {
                if (dragSlide.current === null) return;
                e.preventDefault();
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setDropAt(e.clientY > r.top + r.height / 2 ? i + 1 : i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (dragSlide.current !== null && dropAt !== null) moveSlide(dragSlide.current, dropAt);
                dragSlide.current = null;
                setDropAt(null);
              }}
              onClick={() => {
                if (editingId) finishEditing();
                setIdx(i);
              }}
            >
              <span className="slide-num">{i + 1}</span>
              <div className="thumb-frame" style={{ width: thumbW, height: deck.h * thumbScale }}>
                <div style={{ transform: `scale(${thumbScale})`, transformOrigin: '0 0' }}>
                  <SlideView slide={s} w={deck.w} h={deck.h} font={deck.font} />
                </div>
              </div>
              <div className="thumb-tools" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn sm" title="Duplicate" onClick={() => duplicateSlide(i)}>
                  <Copy size={13} />
                </button>
                <button className="icon-btn sm" title="Delete" onClick={() => deleteSlide(i)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
          <button className="add-slide" onClick={() => newSlide('content')}>
            <Plus size={16} /> New slide
          </button>
        </div>

        <div className="slide-main">
          <div className="slide-stage" ref={stageRef} onMouseDown={onStageDown}>
            <div className="slide-frame" style={{ width: deck.w * scale, height: deck.h * scale }}>
              <div ref={slideRef} className="slide-scaled" style={{ transform: `scale(${scale})` }}>
                <SlideView slide={slide} w={deck.w} h={deck.h} font={deck.font} editingId={editingId} textRef={textRef} interactive />
                {sel && (
                  <div className={`el-sel ${editingId === sel.id ? 'editing' : ''}`} style={{ left: sel.x, top: sel.y, width: sel.w, height: Math.max(sel.h, 1), transform: sel.rot ? `rotate(${sel.rot}deg)` : undefined, borderWidth: 1.5 / scale }}>
                    {editingId !== sel.id &&
                      HANDLES.map((hd) => (
                        <div
                          key={hd}
                          data-handle={hd}
                          className={`el-handle h-${hd}`}
                          style={{
                            width: 10 / scale,
                            height: 10 / scale,
                            borderWidth: 1.5 / scale,
                            left: hd.includes('w') ? -5 / scale : hd.includes('e') ? sel.w - 5 / scale : sel.w / 2 - 5 / scale,
                            top: hd.includes('n') ? -5 / scale : hd.includes('s') ? Math.max(sel.h, 1) - 5 / scale : Math.max(sel.h, 1) / 2 - 5 / scale
                          }}
                        />
                      ))}
                  </div>
                )}
                <div className="guide v" style={{ left: deck.w / 2, width: 1 / scale }} />
                <div className="guide h" style={{ top: deck.h / 2, height: 1 / scale }} />
              </div>
            </div>
          </div>
          {notesOpen && (
            <textarea
              className="notes"
              placeholder="Speaker notes"
              value={slide.notes}
              onFocus={() => h.begin()}
              onChange={(e) => updateSlide((s) => ({ ...s, notes: e.target.value }), true)}
            />
          )}
        </div>
      </div>

      <div className="statusbar">
        <span>
          Slide {idx + 1} of {deck.slides.length}
        </span>
        <span className="grow" />
        <span>Double-click text to edit · drag to move · F5 to present</span>
      </div>

      {presenting !== null && <Presenter deck={deck} start={presenting} onExit={(i) => (setPresenting(null), setIdx(i))} />}
    </div>
  );
}

// ---------- HTML helpers ----------
function htmlText(html: string): string {
  const d = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  d.querySelectorAll('p, li, br, div').forEach((n) => n.append('\n'));
  return (d.body.textContent || '').replace(/\n{2,}/g, '\n').trim();
}
function stripStyle(html: string, prop: string): string {
  const d = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html').body.firstElementChild as HTMLElement;
  d.querySelectorAll<HTMLElement>('[style]').forEach((n) => {
    n.style.removeProperty(prop);
    if (!n.getAttribute('style')) n.removeAttribute('style');
  });
  if (prop === 'color') d.querySelectorAll('font[color]').forEach((n) => n.removeAttribute('color'));
  return d.innerHTML;
}
function setAlign(html: string, align: string): string {
  const d = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html').body.firstElementChild as HTMLElement;
  const blocks = d.querySelectorAll<HTMLElement>('p, li, div');
  if (!blocks.length) return `<p style="text-align:${align}">${html}</p>`;
  blocks.forEach((b) => (b.style.textAlign = align));
  return d.innerHTML;
}
function toggleWrap(html: string, tag: 'b' | 'i' | 'u'): string {
  const d = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html').body.firstElementChild as HTMLElement;
  const sel = tag === 'b' ? 'b, strong' : tag === 'i' ? 'i, em' : 'u';
  const existing = d.querySelectorAll(sel);
  if (existing.length) {
    existing.forEach((n) => n.replaceWith(...Array.from(n.childNodes)));
    return d.innerHTML;
  }
  const blocks = d.querySelectorAll<HTMLElement>('p, li');
  (blocks.length ? Array.from(blocks) : [d]).forEach((b) => {
    const w = document.createElement(tag);
    w.append(...Array.from(b.childNodes));
    b.append(w);
  });
  return d.innerHTML;
}
function toggleList(html: string, tag: 'ul' | 'ol'): string {
  const d = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html').body.firstElementChild as HTMLElement;
  const list = d.querySelector('ul, ol');
  if (list && list.tagName.toLowerCase() === tag) {
    return Array.from(d.querySelectorAll('li'))
      .map((li) => `<p${li.getAttribute('style') ? ` style="${li.getAttribute('style')}"` : ''}>${li.innerHTML}</p>`)
      .join('');
  }
  const items = Array.from(d.querySelectorAll('p, li')).map((n) => `<li${n.getAttribute('style') ? ` style="${n.getAttribute('style')}"` : ''}>${n.innerHTML}</li>`);
  return `<${tag}>${items.join('') || `<li>${d.innerHTML}</li>`}</${tag}>`;
}

const luminance = (hex: string) => {
  const n = parseInt((hex || '#ffffff').replace('#', '').slice(0, 6), 16) || 0;
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};
const guessTextColor = (bg: string) => (luminance(bg) > 0.55 ? '#202124' : '#e3e3e3');
const guessAccent = (bg: string) => (luminance(bg) > 0.55 ? '#1a73e8' : '#7cacf8');
function themeFromSlide(s: Slide): Theme {
  const title = s.els.find((e) => e.role === 'title');
  const body = s.els.find((e) => e.role === 'body' || e.role === 'subtitle');
  const t = THEMES.find((x) => x.bg.toLowerCase() === s.bg.toLowerCase());
  if (t) return t;
  return {
    name: 'Current',
    bg: s.bg,
    title: title?.color || guessTextColor(s.bg),
    text: body?.color || guessTextColor(s.bg),
    accent: guessAccent(s.bg),
    font: title?.font || 'Calibri'
  };
}

export { clamp };

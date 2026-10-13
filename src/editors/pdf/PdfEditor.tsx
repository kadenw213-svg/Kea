import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  MousePointer2,
  TextCursorInput,
  Type,
  Highlighter,
  Underline as UnderlineIcon,
  Strikethrough,
  PenLine,
  Square,
  Circle,
  Minus,
  MoveUpRight,
  Eraser,
  MessageSquarePlus,
  ImagePlus,
  Signature,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Search,
  PanelLeft,
  Moon,
  Save,
  MoreVertical,
  Printer,
  FilePlus2,
  FileOutput,
  RotateCw,
  RotateCcw,
  Trash2,
  Copy,
  ChevronUp,
  ChevronDown,
  X,
  Bold,
  Italic,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Palette,
  PaintBucket,
  ClipboardList,
  FileDown,
  StickyNote,
  Shapes
} from 'lucide-react';
import type { Tab } from '../../store';
import { editorRegistry, setDirty, toast, prompt, useTabs, ask } from '../../store';
import { loadPdf, PasswordError, getTextRects, PDFDocumentProxy, TextItemRect } from './pdfjs';
import type { Annotation, Box, DocState, PageInfo, PageRef, TextAnn, Tool, ImageAnn } from './types';
import { DEFAULTS } from './types';
import { PageView, ToolStyle, measureTextAnn } from './PageView';
import { Thumbnails } from './Thumbnails';
import { SignatureModal } from './SignatureModal';
import { buildPdf, readFormFields, isEncrypted, FormFieldInfo, FormValues } from './save';
import { annBox, rotateAnn, translateAnn, BASELINE_EM } from './geometry';
import { uid, clamp, bytesToDataUrl, modKey, escapeHtml } from '../../lib/util';
import { saveTabFile, exportFile } from '../../lib/save';
import { api } from '../../lib/api';
import { MenuButton, Popover } from '../../components/Popover';
import { ColorPicker } from '../../components/ColorPicker';
import { imagesToPdf, imageToPng, mimeFor } from '../../lib/pdfTools';
import { extOf, baseName } from '../../lib/fileTypes';
import './pdf.css';

const CSS_UNITS = 96 / 72;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

type StyleKey = 'text' | 'highlight' | 'underline' | 'strike' | 'ink' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'whiteout' | 'note';

const baseStyle = (color: string, extra: Partial<ToolStyle> = {}): ToolStyle => ({
  color,
  fill: null,
  strokeWidth: 2,
  opacity: 1,
  fontSize: DEFAULTS.text.fontSize,
  font: DEFAULTS.text.font,
  bold: false,
  italic: false,
  ...extra
});

const INITIAL_STYLES: Record<StyleKey, ToolStyle> = {
  text: baseStyle(DEFAULTS.text.color),
  highlight: baseStyle(DEFAULTS.highlight, { opacity: 0.4 }),
  underline: baseStyle(DEFAULTS.underline),
  strike: baseStyle(DEFAULTS.strike),
  ink: baseStyle(DEFAULTS.ink, { strokeWidth: 2.5 }),
  rect: baseStyle(DEFAULTS.shape),
  ellipse: baseStyle(DEFAULTS.shape),
  line: baseStyle(DEFAULTS.shape),
  arrow: baseStyle(DEFAULTS.shape),
  whiteout: baseStyle('#ffffff', { fill: '#ffffff' }),
  note: baseStyle(DEFAULTS.note)
};

function styleKeyFor(t: Tool | Annotation['type']): StyleKey | null {
  if (t === 'edittext' || t === 'text') return 'text';
  if (t === 'select' || t === 'image') return null;
  return t as StyleKey;
}

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  e: 'edittext',
  t: 'text',
  h: 'highlight',
  u: 'underline',
  k: 'strike',
  d: 'ink',
  r: 'rect',
  o: 'ellipse',
  l: 'line',
  a: 'arrow',
  w: 'whiteout',
  n: 'note'
};

interface Source {
  bytes: Uint8Array;
  doc: PDFDocumentProxy | null;
}

/** Undoable document state held in a ref so pointer handlers always see the latest. */
function useDocHistory() {
  const state = useRef<DocState>({ pages: [], annots: [] });
  const past = useRef<DocState[]>([]);
  const future = useRef<DocState[]>([]);
  const [, force] = useReducer((x) => x + 1, 0);
  return useMemo(
    () => ({
      get: () => state.current,
      reset(s: DocState) {
        state.current = s;
        past.current = [];
        future.current = [];
        force();
      },
      begin() {
        past.current.push(state.current);
        if (past.current.length > 200) past.current.shift();
        future.current = [];
      },
      live(s: DocState) {
        state.current = s;
        force();
      },
      commit(s: DocState) {
        this.begin();
        this.live(s);
      },
      undo() {
        const prev = past.current.pop();
        if (!prev) return false;
        future.current.push(state.current);
        state.current = prev;
        force();
        return true;
      },
      redo() {
        const next = future.current.pop();
        if (!next) return false;
        past.current.push(state.current);
        state.current = next;
        force();
        return true;
      },
      canUndo: () => past.current.length > 0,
      canRedo: () => future.current.length > 0
    }),
    []
  );
}

export default function PdfEditor({ tab, active }: { tab: Tab; active: boolean }) {
  const history = useDocHistory();
  const doc = history.get();
  const [sources, setSources] = useState<Source[]>([]);
  const [infos, setInfos] = useState<Record<string, PageInfo>>({});
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [encrypted, setEncrypted] = useState(false);

  const [tool, setToolState] = useState<Tool>('select');
  const [styles, setStyles] = useState(INITIAL_STYLES);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [darkPages, setDarkPages] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [currentIndex, setCurrentIndex] = useState(0);
  const [sigOpen, setSigOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [formFields, setFormFields] = useState<FormFieldInfo[]>([]);
  const [formValues, setFormValues] = useState<FormValues>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<{ pageId: string; rect: Box }[]>([]);
  const [matchIdx, setMatchIdx] = useState(0);
  const [pageMenu, setPageMenu] = useState<{ x: number; y: number } | null>(null);
  const [pageMenuAnchor, setPageMenuAnchor] = useState<HTMLDivElement | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const pageEls = useRef(new Map<string, HTMLDivElement>());
  const canvases = useRef(new Map<string, { canvas: HTMLCanvasElement; pxPerPt: number }>());
  const textCache = useRef(new Map<string, TextItemRect[]>());
  const clipboard = useRef<Annotation | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const scale = zoom * CSS_UNITS;

  // ---------- Loading ----------
  const loadSourceInfo = async (pdf: PDFDocumentProxy, srcIndex: number) => {
    const out: Record<string, PageInfo> = {};
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      out[`${srcIndex}:${i - 1}`] = { width: vp.width, height: vp.height, baseRotation: page.rotate };
    }
    return out;
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!tab.data) {
          // New, empty PDF: a single blank Letter page.
          setSources([]);
          history.reset({ pages: [{ id: uid(), src: -1, index: 0, rotation: 0, width: 612, height: 792 }], annots: [] });
          setStatus('ready');
          return;
        }
        let pdf: PDFDocumentProxy | null = null;
        let password: string | undefined;
        while (!pdf) {
          try {
            pdf = await loadPdf(tab.data, password);
          } catch (err) {
            if (err instanceof PasswordError) {
              const p = await prompt(err.incorrect ? 'Incorrect password' : 'Password required', `${tab.name} is protected. Enter its password to open it.`, '', 'Password');
              if (p === null) throw new Error('This PDF is password protected.');
              password = p;
            } else throw err;
          }
        }
        if (cancelled) return;
        const info = await loadSourceInfo(pdf, 0);
        if (cancelled) return;
        setSources([{ bytes: tab.data, doc: pdf }]);
        setInfos(info);
        history.reset({
          pages: Array.from({ length: pdf.numPages }, (_, i) => ({ id: uid(), src: 0, index: i, rotation: 0 })),
          annots: []
        });
        // Fit width by default, capped so small pages don't blow up.
        const first = info['0:0'];
        const avail = (scrollRef.current?.clientWidth || 1000) - 64;
        if (first) setZoom(clamp(avail / (first.width * CSS_UNITS), 0.5, 1.25));
        setStatus('ready');
        const enc = password !== undefined || (await isEncrypted(tab.data));
        setEncrypted(enc);
        if (!enc) {
          const fields = await readFormFields(tab.data);
          setFormFields(fields.filter((f) => f.type !== 'other'));
        }
      } catch (err: any) {
        console.error(err);
        setErrorMsg(err?.message || String(err));
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => setScrollRoot(scrollRef.current), []);

  // ---------- Page geometry ----------
  const sizeOf = useCallback(
    (ref: PageRef) => {
      if (ref.src < 0) return { width: ref.width || 612, height: ref.height || 792, rotation: 0 };
      const info = infos[`${ref.src}:${ref.index}`] || { width: 612, height: 792, baseRotation: 0 };
      const swap = ref.rotation % 180 !== 0;
      return {
        width: swap ? info.height : info.width,
        height: swap ? info.width : info.height,
        rotation: (((info.baseRotation + ref.rotation) % 360) + 360) % 360
      };
    },
    [infos]
  );

  // Stable per-page annotation arrays so untouched pages don't re-render.
  const annCache = useRef(new Map<string, Annotation[]>());
  const annotsByPage = useMemo(() => {
    const m = new Map<string, Annotation[]>();
    for (const a of doc.annots) {
      if (!m.has(a.pageId)) m.set(a.pageId, []);
      m.get(a.pageId)!.push(a);
    }
    const out = new Map<string, Annotation[]>();
    for (const p of doc.pages) {
      const next = m.get(p.id) || [];
      const prev = annCache.current.get(p.id);
      out.set(p.id, prev && prev.length === next.length && prev.every((a, i) => a === next[i]) ? prev : next);
    }
    annCache.current = out;
    return out;
  }, [doc.annots, doc.pages]);

  const markDirty = () => setDirty(tab.id, true);

  // ---------- Annotation callbacks (stable) ----------
  const latest = useRef<any>({});
  latest.current = { tool, editingId, selectedId, styles, sources, sizeOf };

  const setTool = useCallback((t: Tool) => {
    setToolState(t);
    setEditingId(null);
    if (t !== 'select') setSelectedId(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const removeEmptyEditing = (id: string | null) => {
    if (!id) return;
    const a = history.get().annots.find((x) => x.id === id);
    if (a && (a.type === 'text' || a.type === 'note') && !a.text.trim()) {
      const s = history.get();
      history.live({ ...s, annots: s.annots.filter((x) => x.id !== id) });
      setSelectedId((cur) => (cur === id ? null : cur));
    }
  };

  const cb = useMemo(
    () => ({
      onSelect: (id: string | null) => setSelectedId(id),
      onBeginChange: () => {
        history.begin();
        markDirty();
      },
      onLive: (a: Annotation) => {
        const s = history.get();
        history.live({ ...s, annots: s.annots.map((x) => (x.id === a.id ? a : x)) });
        markDirty();
      },
      onCreate: (a: Annotation, opts?: { edit?: boolean }) => {
        const prevEditing = latest.current.editingId;
        if (prevEditing) removeEmptyEditing(prevEditing);
        const s = history.get();
        history.commit({ ...s, annots: [...s.annots, a] });
        markDirty();
        setSelectedId(a.id);
        setEditingId(opts?.edit ? a.id : null);
        const t: Tool = latest.current.tool;
        if (['rect', 'ellipse', 'line', 'arrow', 'whiteout', 'note'].includes(t)) setToolState('select');
      },
      onEditing: (id: string | null) => {
        setEditingId((cur) => {
          if (cur && cur !== id) setTimeout(() => removeEmptyEditing(cur));
          return id;
        });
        if (id) history.begin();
      },
      onEditExisting: (pageId: string, x: number, y: number) => editExistingText(pageId, x, y),
      onCanvas: (pageId: string, canvas: HTMLCanvasElement | null, pxPerPt: number) => {
        if (canvas) canvases.current.set(pageId, { canvas, pxPerPt });
        else canvases.current.delete(pageId);
      },
      onPageEl: (pageId: string, el: HTMLDivElement | null) => {
        if (el) pageEls.current.set(pageId, el);
        else pageEls.current.delete(pageId);
      }
    }),
    []
  );

  // ---------- Edit existing text ----------
  const textRectsFor = async (ref: PageRef): Promise<TextItemRect[]> => {
    if (ref.src < 0) return [];
    const { rotation } = latest.current.sizeOf(ref);
    const key = `${ref.src}:${ref.index}:${rotation}`;
    let rects = textCache.current.get(key);
    if (!rects) {
      const src: Source = latest.current.sources[ref.src];
      const page = await src.doc!.getPage(ref.index + 1);
      rects = await getTextRects(page, rotation);
      textCache.current.set(key, rects);
    }
    return rects;
  };

  const sampleColors = (pageId: string, b: Box): { fg: string; bg: string } => {
    const entry = canvases.current.get(pageId);
    const fallback = { fg: '#000000', bg: '#ffffff' };
    if (!entry) return fallback;
    const { canvas, pxPerPt } = entry;
    const x = Math.max(0, Math.floor(b.x * pxPerPt));
    const y = Math.max(0, Math.floor(b.y * pxPerPt));
    const w = Math.min(canvas.width - x, Math.ceil(b.w * pxPerPt));
    const h = Math.min(canvas.height - y, Math.ceil(b.h * pxPerPt));
    if (w <= 0 || h <= 0) return fallback;
    const data = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(x, y, w, h).data;
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let bgKey = 0,
      best = -1;
    counts.forEach((c, k) => {
      if (c > best) {
        best = c;
        bgKey = k;
      }
    });
    const br = ((bgKey >> 10) & 31) * 8 + 4,
      bgG = ((bgKey >> 5) & 31) * 8 + 4,
      bb = (bgKey & 31) * 8 + 4;
    let fg = [0, 0, 0],
      far = -1;
    for (let i = 0; i < data.length; i += 4) {
      const d = Math.abs(data[i] - br) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bb);
      if (d > far) {
        far = d;
        fg = [data[i], data[i + 1], data[i + 2]];
      }
    }
    const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('');
    const bgHex = br > 240 && bgG > 240 && bb > 240 ? '#ffffff' : hex(br, bgG, bb);
    // Snap near-black text to pure black so it doesn't look washed out.
    const fgHex = fg[0] < 60 && fg[1] < 60 && fg[2] < 60 ? '#000000' : hex(fg[0], fg[1], fg[2]);
    return { fg: fgHex, bg: bgHex };
  };

  const editExistingText = async (pageId: string, x: number, y: number) => {
    const ref = history.get().pages.find((p) => p.id === pageId);
    if (!ref) return;
    const rects = await textRectsFor(ref);
    const tol = 2;
    const hit = rects.find((r) => x >= r.x - tol && x <= r.x + r.w + tol && y >= r.y - tol && y <= r.y + r.h + tol);
    if (!hit) {
      toast('No text there. Click directly on a line of existing text, or use Add text.');
      return;
    }
    // Grow the clicked run into its neighbours on the same line.
    let line = [hit];
    if (hit.horizontal) {
      const same = rects.filter((r) => r.horizontal && Math.abs(r.baseY - hit.baseY) < hit.fontSize * 0.3 && Math.abs(r.fontSize - hit.fontSize) < hit.fontSize * 0.25).sort((a, b) => a.x - b.x);
      const idx = same.indexOf(hit);
      let lo = idx,
        hi = idx;
      while (lo > 0 && same[lo].x - (same[lo - 1].x + same[lo - 1].w) < hit.fontSize * 0.9) lo--;
      while (hi < same.length - 1 && same[hi + 1].x - (same[hi].x + same[hi].w) < hit.fontSize * 0.9) hi++;
      line = same.slice(lo, hi + 1);
    }
    let text = '';
    line.forEach((r, i) => {
      if (i > 0) {
        const gap = r.x - (line[i - 1].x + line[i - 1].w);
        if (gap > r.fontSize * 0.15 && !text.endsWith(' ') && !r.str.startsWith(' ')) text += ' ';
      }
      text += r.str;
    });
    const minX = Math.min(...line.map((r) => r.x));
    const minY = Math.min(...line.map((r) => r.y));
    const maxX = Math.max(...line.map((r) => r.x + r.w));
    const maxY = Math.max(...line.map((r) => r.y + r.h));
    const box: Box = { x: minX - 1, y: minY - 1, w: maxX - minX + 2, h: maxY - minY + 2 };
    const colors = sampleColors(pageId, box);

    let bold = false,
      italic = false;
    try {
      const src: Source = latest.current.sources[ref.src];
      const page = await src.doc!.getPage(ref.index + 1);
      const fontObj: any = (page as any).commonObjs.get(hit.fontName);
      const name = String(fontObj?.name || fontObj?.loadedName || '');
      bold = /bold|black|heavy|semibold/i.test(name) || !!fontObj?.bold;
      italic = /italic|oblique/i.test(name) || !!fontObj?.italic;
    } catch {}
    const font = hit.family === 'serif' ? 'Times' : hit.family === 'monospace' ? 'Courier' : 'Helvetica';
    const fontSize = Math.round(hit.fontSize * 10) / 10;
    const s = history.get();
    const whiteout: Annotation = { id: uid(), pageId, type: 'whiteout', ...box, stroke: null, fill: colors.bg, strokeWidth: 0, opacity: 1 };
    const t: TextAnn = {
      id: uid(),
      pageId,
      type: 'text',
      x: minX,
      y: hit.horizontal ? hit.baseY - fontSize * BASELINE_EM[font] : minY,
      w: maxX - minX + 2,
      h: fontSize * 1.2,
      text,
      fontSize,
      font,
      bold,
      italic,
      color: colors.fg,
      align: 'left',
      auto: true
    };
    t.w = Math.max(t.w, measureTextAnn(t).width + 2);
    history.commit({ ...s, annots: [...s.annots, whiteout, t] });
    markDirty();
    setSelectedId(t.id);
    setEditingId(t.id);
  };

  // ---------- Markup from text selection ----------
  useEffect(() => {
    if (!active || !['highlight', 'underline', 'strike'].includes(tool)) return;
    const onUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!scrollRef.current?.contains(range.commonAncestorContainer)) return;
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
      const perPage = new Map<string, Box[]>();
      for (const r of rects) {
        const cx = r.left + r.width / 2,
          cy = r.top + r.height / 2;
        for (const [pid, el] of pageEls.current) {
          const pr = el.getBoundingClientRect();
          if (cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom) {
            if (!perPage.has(pid)) perPage.set(pid, []);
            perPage.get(pid)!.push({ x: (r.left - pr.left) / scale, y: (r.top - pr.top) / scale, w: r.width / scale, h: r.height / scale });
            break;
          }
        }
      }
      sel.removeAllRanges();
      if (!perPage.size) return;
      const st = styles[tool as StyleKey];
      const s = history.get();
      const created: Annotation[] = [];
      perPage.forEach((boxes, pageId) => {
        // Merge fragments that sit on the same line.
        boxes.sort((a, b) => a.y - b.y || a.x - b.x);
        const merged: Box[] = [];
        for (const b of boxes) {
          const m = merged.find((x) => Math.abs(x.y - b.y) < b.h * 0.5 && Math.abs(x.h - b.h) < b.h * 0.5 && b.x <= x.x + x.w + b.h * 0.6);
          if (m) {
            const r = Math.max(m.x + m.w, b.x + b.w);
            m.x = Math.min(m.x, b.x);
            m.w = r - m.x;
            const bottom = Math.max(m.y + m.h, b.y + b.h);
            m.y = Math.min(m.y, b.y);
            m.h = bottom - m.y;
          } else merged.push({ ...b });
        }
        created.push({ id: uid(), pageId, type: tool as 'highlight', rects: merged, color: st.color, opacity: tool === 'highlight' ? st.opacity : 1 });
      });
      history.commit({ ...s, annots: [...s.annots, ...created] });
      markDirty();
    };
    document.addEventListener('mouseup', onUp);
    return () => document.removeEventListener('mouseup', onUp);
  }, [active, tool, styles, scale]);

  // ---------- Selection helpers ----------
  const selected = doc.annots.find((a) => a.id === selectedId) || null;

  const updateAnn = (id: string, patch: Partial<Annotation>) => {
    const s = history.get();
    history.commit({ ...s, annots: s.annots.map((a) => (a.id === id ? ({ ...a, ...patch } as Annotation) : a)) });
    markDirty();
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    const s = history.get();
    history.commit({ ...s, annots: s.annots.filter((a) => a.id !== selectedId) });
    setSelectedId(null);
    setEditingId(null);
    markDirty();
  };

  const duplicate = (a: Annotation, offset = 12) => {
    const copy = translateAnn({ ...a, id: uid() } as Annotation, offset, offset);
    const s = history.get();
    history.commit({ ...s, annots: [...s.annots, copy] });
    setSelectedId(copy.id);
    markDirty();
  };

  /** Change a style property: applies to the selection and becomes the tool default. */
  const setStyle = (patch: Partial<ToolStyle>) => {
    const key = selected ? styleKeyFor(selected.type) : styleKeyFor(tool);
    if (key) setStyles((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
    if (!selected) return;
    const p: any = {};
    const a = selected;
    if (patch.color !== undefined) {
      if (a.type === 'rect' || a.type === 'ellipse') p.stroke = patch.color;
      else p.color = patch.color;
    }
    if (patch.fill !== undefined) {
      if (a.type === 'text') p.bg = patch.fill;
      else p.fill = patch.fill;
    }
    if (patch.strokeWidth !== undefined) {
      if (a.type === 'rect' || a.type === 'ellipse') p.strokeWidth = patch.strokeWidth;
      else p.width = patch.strokeWidth;
    }
    if (patch.opacity !== undefined) p.opacity = patch.opacity;
    if (a.type === 'text') {
      if (patch.font) p.font = patch.font;
      if (patch.fontSize) p.fontSize = patch.fontSize;
      if (patch.bold !== undefined) p.bold = patch.bold;
      if (patch.italic !== undefined) p.italic = patch.italic;
      const next = { ...a, ...p } as TextAnn;
      const m = measureTextAnn(next);
      if (next.auto) p.w = m.width + 2;
      p.h = Math.max(m.height, p.fontSize ? m.height : a.h);
    }
    updateAnn(a.id, p);
  };

  const currentStyle: ToolStyle = (() => {
    if (selected) {
      const a: any = selected;
      const key = styleKeyFor(selected.type);
      const base = key ? styles[key] : INITIAL_STYLES.text;
      return {
        ...base,
        color: a.color ?? a.stroke ?? base.color,
        fill: a.type === 'text' ? (a.bg ?? null) : (a.fill ?? null),
        strokeWidth: a.strokeWidth ?? a.width ?? base.strokeWidth,
        opacity: a.opacity ?? base.opacity,
        fontSize: a.fontSize ?? base.fontSize,
        font: a.font ?? base.font,
        bold: a.bold ?? base.bold,
        italic: a.italic ?? base.italic
      };
    }
    const key = styleKeyFor(tool);
    return key ? styles[key] : INITIAL_STYLES.text;
  })();

  // ---------- Images & signatures ----------
  const placeImage = async (dataUrl: string, signature = false, targetPageId?: string) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const s = history.get();
    const pageRef = s.pages.find((p) => p.id === targetPageId) || s.pages[currentIndex] || s.pages[0];
    if (!pageRef) return;
    const size = sizeOf(pageRef);
    const maxW = signature ? Math.min(180, size.width * 0.35) : size.width * 0.5;
    const ratio = img.naturalHeight / img.naturalWidth;
    let w = Math.min(maxW, img.naturalWidth * 0.75);
    let h = w * ratio;
    if (h > size.height * 0.5) {
      h = size.height * 0.5;
      w = h / ratio;
    }
    // Centre on the visible part of the page.
    const el = pageEls.current.get(pageRef.id);
    let cy = size.height / 2;
    if (el && scrollRef.current) {
      const pr = el.getBoundingClientRect();
      const vr = scrollRef.current.getBoundingClientRect();
      const top = Math.max(pr.top, vr.top),
        bottom = Math.min(pr.bottom, vr.bottom);
      if (bottom > top) cy = ((top + bottom) / 2 - pr.top) / scale;
    }
    const a: ImageAnn = { id: uid(), pageId: pageRef.id, type: 'image', x: (size.width - w) / 2, y: clamp(cy - h / 2, 0, size.height - h), w, h, dataUrl, signature };
    history.commit({ ...s, annots: [...s.annots, a] });
    markDirty();
    setToolState('select');
    setSelectedId(a.id);
  };

  const insertImage = async () => {
    const [f] = await api.openDialog({ title: 'Insert image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
    if (!f) return;
    const ext = extOf(f.name);
    const url = ext === 'png' || ext === 'jpg' || ext === 'jpeg' ? await bytesToDataUrl(f.data, mimeFor(f.name)) : await bytesToDataUrl((await imageToPng(f.data, mimeFor(f.name))).png, 'image/png');
    placeImage(url);
  };

  // ---------- Page operations ----------
  const targetPages = (): string[] => {
    const s = history.get();
    if (selectedPages.size) return s.pages.filter((p) => selectedPages.has(p.id)).map((p) => p.id);
    return s.pages[currentIndex] ? [s.pages[currentIndex].id] : [];
  };

  const rotatePages = (delta: number, ids = targetPages()) => {
    const s = history.get();
    const set = new Set(ids);
    let annots = s.annots;
    const pages = s.pages.map((p) => {
      if (!set.has(p.id)) return p;
      const { width, height } = sizeOf(p);
      const steps = delta > 0 ? 1 : 3;
      annots = annots.map((a) => (a.pageId === p.id ? rotateAnn(a, steps, width, height) : a));
      if (p.src < 0) return { ...p, width: p.height, height: p.width };
      return { ...p, rotation: (((p.rotation + delta) % 360) + 360) % 360 };
    });
    history.commit({ pages, annots });
    markDirty();
  };

  const deletePages = async (ids = targetPages()) => {
    const s = history.get();
    if (ids.length >= s.pages.length) {
      toast("A PDF needs at least one page. Keep one page or close the file instead.", 'error');
      return;
    }
    const set = new Set(ids);
    history.commit({ pages: s.pages.filter((p) => !set.has(p.id)), annots: s.annots.filter((a) => !set.has(a.pageId)) });
    setSelectedPages(new Set());
    setCurrentIndex((i) => Math.min(i, s.pages.length - ids.length - 1));
    markDirty();
  };

  const duplicatePages = (ids = targetPages()) => {
    const s = history.get();
    const pages: PageRef[] = [];
    const annots = [...s.annots];
    for (const p of s.pages) {
      pages.push(p);
      if (ids.includes(p.id)) {
        const copy = { ...p, id: uid() };
        pages.push(copy);
        s.annots.filter((a) => a.pageId === p.id).forEach((a) => annots.push({ ...a, id: uid(), pageId: copy.id }));
      }
    }
    history.commit({ pages, annots });
    markDirty();
  };

  const insertBlank = () => {
    const s = history.get();
    const ref = s.pages[currentIndex];
    const size = ref ? sizeOf(ref) : { width: 612, height: 792 };
    const blank: PageRef = { id: uid(), src: -1, index: 0, rotation: 0, width: size.width, height: size.height };
    const pages = [...s.pages];
    pages.splice(currentIndex + 1, 0, blank);
    history.commit({ ...s, pages });
    markDirty();
    setTimeout(() => scrollToPage(currentIndex + 1), 50);
  };

  const insertFromFile = async () => {
    const files = await api.openDialog({
      title: 'Insert pages from…',
      multi: true,
      filters: [
        { name: 'PDF or images', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: 'PDF', extensions: ['pdf'] }
      ]
    });
    if (!files.length) return;
    try {
      const newSources: Source[] = [];
      const pdfs = files.filter((f) => extOf(f.name) === 'pdf');
      const imgs = files.filter((f) => extOf(f.name) !== 'pdf');
      for (const f of pdfs) newSources.push({ bytes: f.data, doc: await loadPdf(f.data) });
      if (imgs.length) {
        const bytes = await imagesToPdf(imgs);
        newSources.push({ bytes, doc: await loadPdf(bytes) });
      }
      const base = sources.length;
      let newInfos: Record<string, PageInfo> = {};
      const newPages: PageRef[] = [];
      for (let i = 0; i < newSources.length; i++) {
        const d = newSources[i].doc!;
        newInfos = { ...newInfos, ...(await loadSourceInfo(d, base + i)) };
        for (let j = 0; j < d.numPages; j++) newPages.push({ id: uid(), src: base + i, index: j, rotation: 0 });
      }
      setSources((s) => [...s, ...newSources]);
      setInfos((x) => ({ ...x, ...newInfos }));
      const s = history.get();
      const pages = [...s.pages];
      pages.splice(currentIndex + 1, 0, ...newPages);
      history.commit({ ...s, pages });
      markDirty();
      toast(`Inserted ${newPages.length} page${newPages.length > 1 ? 's' : ''}`, 'success');
    } catch (err: any) {
      toast(`Couldn't insert: ${err.message}`, 'error');
    }
  };

  const reorderPages = (ids: string[], toIndex: number) => {
    const s = history.get();
    const moving = s.pages.filter((p) => ids.includes(p.id));
    const before = s.pages.slice(0, toIndex).filter((p) => !ids.includes(p.id));
    const after = s.pages.slice(toIndex).filter((p) => !ids.includes(p.id));
    const pages = [...before, ...moving, ...after];
    if (pages.every((p, i) => p === s.pages[i])) return;
    history.commit({ ...s, pages });
    markDirty();
  };

  const movePages = (dir: -1 | 1) => {
    const s = history.get();
    const ids = targetPages();
    const idxs = ids.map((id) => s.pages.findIndex((p) => p.id === id)).sort((a, b) => a - b);
    if (!idxs.length) return;
    const to = dir < 0 ? Math.max(0, idxs[0] - 1) : Math.min(s.pages.length, idxs[idxs.length - 1] + 2);
    reorderPages(ids, to);
    setCurrentIndex((i) => clamp(i + dir, 0, s.pages.length - 1));
  };

  const extractPages = async () => {
    const ids = targetPages();
    const s = history.get();
    const pages = s.pages.filter((p) => ids.includes(p.id));
    try {
      const bytes = await buildPdf(sources.map((x) => x.bytes), pages, s.annots.filter((a) => ids.includes(a.pageId)));
      useTabs.getState().addTab({ kind: 'pdf', name: `${baseName(tab.name)} (pages).pdf`, path: null, data: bytes });
      toast(`Extracted ${pages.length} page${pages.length > 1 ? 's' : ''} into a new tab`, 'success');
    } catch (err: any) {
      toast(`Couldn't extract: ${err.message}`, 'error');
    }
  };

  // ---------- Navigation & zoom ----------
  const scrollToPage = (i: number) => {
    const ref = history.get().pages[i];
    const el = ref && pageEls.current.get(ref.id);
    if (el && scrollRef.current) scrollRef.current.scrollTo({ top: el.offsetTop - 16 });
    setCurrentIndex(i);
  };

  const onScroll = () => {
    const sc = scrollRef.current;
    if (!sc) return;
    const mid = sc.scrollTop + sc.clientHeight * 0.35;
    const pages = history.get().pages;
    for (let i = 0; i < pages.length; i++) {
      const el = pageEls.current.get(pages[i].id);
      if (el && el.offsetTop + el.offsetHeight > mid) {
        if (i !== currentIndex) setCurrentIndex(i);
        break;
      }
    }
  };

  const zoomAnchor = useRef<{ ratio: number } | null>(null);
  const applyZoom = (z: number) => {
    const sc = scrollRef.current;
    if (sc) zoomAnchor.current = { ratio: (sc.scrollTop + sc.clientHeight / 2) / Math.max(1, sc.scrollHeight) };
    setZoom(clamp(z, 0.1, 6));
  };
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (sc && zoomAnchor.current) {
      sc.scrollTop = zoomAnchor.current.ratio * sc.scrollHeight - sc.clientHeight / 2;
      zoomAnchor.current = null;
    }
  }, [zoom]);

  const zoomStep = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOM_STEPS.find((z) => z > zoom + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001);
    applyZoom(next ?? zoom);
  };
  const fitWidth = () => {
    const ref = history.get().pages[currentIndex];
    if (!ref || !scrollRef.current) return;
    applyZoom((scrollRef.current.clientWidth - 64) / (sizeOf(ref).width * CSS_UNITS));
  };
  const fitPage = () => {
    const ref = history.get().pages[currentIndex];
    if (!ref || !scrollRef.current) return;
    const s = sizeOf(ref);
    applyZoom(Math.min((scrollRef.current.clientWidth - 64) / (s.width * CSS_UNITS), (scrollRef.current.clientHeight - 32) / (s.height * CSS_UNITS)));
    setTimeout(() => scrollToPage(currentIndex), 30);
  };

  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => {
        const next = clamp(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.1, 6);
        zoomAnchor.current = { ratio: (sc.scrollTop + sc.clientHeight / 2) / Math.max(1, sc.scrollHeight) };
        return next;
      });
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => sc.removeEventListener('wheel', onWheel);
  }, []);

  // ---------- Search ----------
  useEffect(() => {
    if (!query.trim()) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const q = query.toLowerCase();
      const found: { pageId: string; rect: Box }[] = [];
      for (const ref of history.get().pages) {
        const rects = await textRectsFor(ref);
        if (cancelled) return;
        for (const r of rects) {
          const s = r.str.toLowerCase();
          let from = 0;
          let i: number;
          while ((i = s.indexOf(q, from)) >= 0) {
            const len = Math.max(1, s.length);
            const rect = r.horizontal ? { x: r.x + (r.w * i) / len, y: r.y, w: (r.w * q.length) / len, h: r.h } : { x: r.x, y: r.y, w: r.w, h: r.h };
            found.push({ pageId: ref.id, rect });
            from = i + q.length;
          }
        }
      }
      if (!cancelled) {
        setMatches(found);
        setMatchIdx(0);
        if (found.length) revealMatch(found[0]);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, doc.pages]);

  const revealMatch = (m: { pageId: string; rect: Box }) => {
    const el = pageEls.current.get(m.pageId);
    const sc = scrollRef.current;
    if (!el || !sc) return;
    const top = el.offsetTop + m.rect.y * scale - sc.clientHeight / 3;
    sc.scrollTo({ top, behavior: 'smooth' });
  };

  const stepMatch = (dir: 1 | -1) => {
    if (!matches.length) return;
    const i = (matchIdx + dir + matches.length) % matches.length;
    setMatchIdx(i);
    revealMatch(matches[i]);
  };

  const searchRectsByPage = useMemo(() => {
    const m = new Map<string, { rect: Box; active: boolean }[]>();
    matches.forEach((x, i) => {
      if (!m.has(x.pageId)) m.set(x.pageId, []);
      m.get(x.pageId)!.push({ rect: x.rect, active: i === matchIdx });
    });
    return m;
  }, [matches, matchIdx]);
  const NO_RECTS = useMemo(() => [], []);

  // ---------- Save / print ----------
  const build = () => {
    const s = history.get();
    return buildPdf(
      sources.map((x) => x.bytes),
      s.pages,
      s.annots.filter((a) => !(a.type === 'text' && !a.text.trim())),
      formValues
    );
  };

  const save = async (saveAs: boolean) => {
    if (encrypted) {
      await ask(
        'This PDF is encrypted',
        "Slate can view and annotate this PDF, but it can't write encrypted files yet. Remove the password in the app that created it, then edit it here.",
        [{ id: 'ok', label: 'OK', primary: true }]
      );
      return false;
    }
    setEditingId(null);
    return saveTabFile(tab.id, [{ name: 'PDF document', ext: 'pdf', build }], saveAs);
  };

  const print = async () => {
    toast('Preparing pages for printing…');
    try {
      const bytes = await build();
      const pdf = await loadPdf(bytes);
      let html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{margin:0}html,body{margin:0;padding:0}img{display:block;width:100%;page-break-after:always;break-after:page}img:last-child{page-break-after:auto;break-after:auto}</style></head><body>`;
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 2 });
        const c = document.createElement('canvas');
        c.width = vp.width;
        c.height = vp.height;
        await page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
        html += `<img src="${c.toDataURL('image/jpeg', 0.92)}">`;
      }
      html += '</body></html>';
      pdf.destroy();
      await api.printHtml(html);
    } catch (err: any) {
      toast(`Print failed: ${err.message}`, 'error');
    }
  };

  const saveCopy = () =>
    exportFile(`${baseName(tab.name)} copy.pdf`, { name: 'PDF document', ext: 'pdf', build });

  const latestHandlers = useRef({ save, print, build });
  latestHandlers.current = { save, print, build };
  useEffect(() => {
    editorRegistry.set(tab.id, {
      save: (a) => latestHandlers.current.save(a),
      print: () => latestHandlers.current.print(),
      debugBuild: () => latestHandlers.current.build()
    });
  }, [tab.id]);

  // ---------- Keyboard ----------
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
      const mod = modKey(e);
      const k = e.key.toLowerCase();
      if (mod && k === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInput.current?.select(), 0);
        return;
      }
      if (mod && (k === '=' || k === '+')) {
        e.preventDefault();
        zoomStep(1);
        return;
      }
      if (mod && k === '-') {
        e.preventDefault();
        zoomStep(-1);
        return;
      }
      if (mod && k === '0') {
        e.preventDefault();
        fitWidth();
        return;
      }
      if (typing) return;
      if (mod && k === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (history.undo()) markDirty();
        setSelectedId(null);
      } else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) {
        e.preventDefault();
        if (history.redo()) markDirty();
      } else if (mod && k === 'c' && selected) {
        clipboard.current = selected;
      } else if (mod && k === 'v' && clipboard.current) {
        e.preventDefault();
        const pid = history.get().pages[currentIndex]?.id;
        duplicate({ ...clipboard.current, pageId: pid || clipboard.current.pageId } as Annotation, clipboard.current.pageId === pid ? 12 : 0);
      } else if (mod && k === 'd' && selected) {
        e.preventDefault();
        duplicate(selected);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        deleteSelected();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPages.size) {
        e.preventDefault();
        deletePages();
      } else if (e.key === 'Escape') {
        if (selectedId) setSelectedId(null);
        else if (tool !== 'select') setTool('select');
        setSelectedPages(new Set());
      } else if (e.key === 'Enter' && selected && (selected.type === 'text' || selected.type === 'note')) {
        e.preventDefault();
        cb.onEditing(selected.id);
      } else if (selected && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const s = history.get();
        history.commit({ ...s, annots: s.annots.map((a) => (a.id === selected.id ? translateAnn(a, dx, dy) : a)) });
        markDirty();
      } else if (!mod && !e.altKey && TOOL_KEYS[k]) {
        setTool(TOOL_KEYS[k]);
      } else if (!mod && k === 'i') {
        insertImage();
      } else if (!mod && k === 's') {
        setSigOpen(true);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        scrollToPage(Math.min(currentIndex + 1, doc.pages.length - 1));
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        scrollToPage(Math.max(currentIndex - 1, 0));
      } else if (e.key === 'Home' && !selected) {
        scrollToPage(0);
      } else if (e.key === 'End' && !selected) {
        scrollToPage(doc.pages.length - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------- Render ----------
  if (status === 'error') {
    return (
      <div className="center-fill">
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <h3 style={{ color: 'var(--text)', fontWeight: 500 }}>Couldn't open this PDF</h3>
          <p>{errorMsg}</p>
        </div>
      </div>
    );
  }

  const docs = sources.map((s) => s.doc);
  const pageCount = doc.pages.length;
  const showOptions = tool !== 'select' || !!selected;
  const optType: string = selected ? selected.type : tool;

  const ToolBtn = ({ t, icon, label, keyHint }: { t: Tool; icon: React.ReactNode; label: string; keyHint?: string }) => (
    <button className={`icon-btn ${tool === t ? 'active' : ''}`} title={`${label}${keyHint ? ` (${keyHint})` : ''}`} onClick={() => setTool(t)}>
      {icon}
    </button>
  );

  const markupIcon = tool === 'underline' ? <UnderlineIcon size={18} /> : tool === 'strike' ? <Strikethrough size={18} /> : <Highlighter size={18} />;
  const shapeIcon = tool === 'ellipse' ? <Circle size={18} /> : tool === 'line' ? <Minus size={18} /> : tool === 'arrow' ? <MoveUpRight size={18} /> : tool === 'rect' ? <Square size={18} /> : <Shapes size={18} />;

  return (
    <div className="pdf-editor">
      <div className="toolbar">
        <button className={`icon-btn ${sidebar ? 'active' : ''}`} title="Pages panel" onClick={() => setSidebar((s) => !s)}>
          <PanelLeft size={18} />
        </button>
        <div className="tb-sep" />
        <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={!history.canUndo()} onClick={() => history.undo() && markDirty()}>
          <Undo2 size={18} />
        </button>
        <button className="icon-btn" title="Redo (Ctrl+Y)" disabled={!history.canRedo()} onClick={() => history.redo() && markDirty()}>
          <Redo2 size={18} />
        </button>
        <div className="tb-sep" />
        <ToolBtn t="select" icon={<MousePointer2 size={18} />} label="Select & move" keyHint="V" />
        <ToolBtn t="edittext" icon={<TextCursorInput size={18} />} label="Edit existing text" keyHint="E" />
        <ToolBtn t="text" icon={<Type size={18} />} label="Add text" keyHint="T" />
        <MenuButton
          title="Highlight, underline, strikethrough"
          button={() => (
            <button className={`icon-btn ${['highlight', 'underline', 'strike'].includes(tool) ? 'active' : ''} split`}>
              {markupIcon}
            </button>
          )}
        >
          {(close) => (
            <>
              <button className="menu-item" onClick={() => (setTool('highlight'), close())}>
                <Highlighter size={16} /> Highlight <span className="kbd">H</span>
              </button>
              <button className="menu-item" onClick={() => (setTool('underline'), close())}>
                <UnderlineIcon size={16} /> Underline <span className="kbd">U</span>
              </button>
              <button className="menu-item" onClick={() => (setTool('strike'), close())}>
                <Strikethrough size={16} /> Strikethrough <span className="kbd">K</span>
              </button>
            </>
          )}
        </MenuButton>
        <ToolBtn t="ink" icon={<PenLine size={18} />} label="Draw" keyHint="D" />
        <MenuButton
          title="Shapes"
          button={() => <button className={`icon-btn ${['rect', 'ellipse', 'line', 'arrow'].includes(tool) ? 'active' : ''}`}>{shapeIcon}</button>}
        >
          {(close) => (
            <>
              <button className="menu-item" onClick={() => (setTool('rect'), close())}>
                <Square size={16} /> Rectangle <span className="kbd">R</span>
              </button>
              <button className="menu-item" onClick={() => (setTool('ellipse'), close())}>
                <Circle size={16} /> Ellipse <span className="kbd">O</span>
              </button>
              <button className="menu-item" onClick={() => (setTool('line'), close())}>
                <Minus size={16} /> Line <span className="kbd">L</span>
              </button>
              <button className="menu-item" onClick={() => (setTool('arrow'), close())}>
                <MoveUpRight size={16} /> Arrow <span className="kbd">A</span>
              </button>
            </>
          )}
        </MenuButton>
        <ToolBtn t="whiteout" icon={<Eraser size={18} />} label="Whiteout / redact area" keyHint="W" />
        <ToolBtn t="note" icon={<MessageSquarePlus size={18} />} label="Comment" keyHint="N" />
        <button className="icon-btn" title="Insert image (I)" onClick={insertImage}>
          <ImagePlus size={18} />
        </button>
        <button className="icon-btn" title="Sign (S)" onClick={() => setSigOpen(true)}>
          <Signature size={18} />
        </button>

        <div className="tb-spacer" />

        <button className={`icon-btn ${searchOpen ? 'active' : ''}`} title="Find (Ctrl+F)" onClick={() => (setSearchOpen((o) => !o), setTimeout(() => searchInput.current?.focus(), 0))}>
          <Search size={18} />
        </button>
        {formFields.length > 0 && (
          <button className={`icon-btn ${formOpen ? 'active' : ''}`} title="Fill form" onClick={() => setFormOpen((o) => !o)}>
            <ClipboardList size={18} />
          </button>
        )}
        <button className={`icon-btn ${darkPages ? 'active' : ''}`} title="Dark pages (view only)" onClick={() => setDarkPages((d) => !d)}>
          <Moon size={18} />
        </button>
        <div className="tb-sep" />
        <button className="icon-btn" title="Zoom out (Ctrl+-)" onClick={() => zoomStep(-1)}>
          <ZoomOut size={18} />
        </button>
        <MenuButton
          button={() => (
            <button className="zoom-label" title="Zoom">
              {Math.round(zoom * 100)}%
            </button>
          )}
        >
          {(close) => (
            <>
              <button className="menu-item" onClick={() => (fitWidth(), close())}>
                Fit width <span className="kbd">Ctrl+0</span>
              </button>
              <button className="menu-item" onClick={() => (fitPage(), close())}>
                Fit page
              </button>
              <div className="menu-sep" />
              {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((z) => (
                <button key={z} className="menu-item" onClick={() => (applyZoom(z), close())}>
                  {z * 100}%
                </button>
              ))}
            </>
          )}
        </MenuButton>
        <button className="icon-btn" title="Zoom in (Ctrl++)" onClick={() => zoomStep(1)}>
          <ZoomIn size={18} />
        </button>
        <div className="tb-sep" />
        <button className="btn primary sm" onClick={() => save(false)} title="Save (Ctrl+S)">
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
              <button className="menu-item" onClick={() => (saveCopy(), close())}>
                <FileDown size={16} /> Save a copy…
              </button>
              <button className="menu-item" onClick={() => (print(), close())}>
                <Printer size={16} /> Print… <span className="kbd">Ctrl+P</span>
              </button>
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => (insertBlank(), close())}>
                <StickyNote size={16} /> Insert blank page
              </button>
              <button className="menu-item" onClick={() => (insertFromFile(), close())}>
                <FilePlus2 size={16} /> Insert pages from file…
              </button>
              <button className="menu-item" onClick={() => (extractPages(), close())}>
                <FileOutput size={16} /> Extract selected pages
              </button>
            </>
          )}
        </MenuButton>
      </div>

      {(showOptions || searchOpen) && (
        <div className="subbar-row">
          {showOptions && (
            <div className="subbar">
              <OptionsBar
                type={optType}
                style={currentStyle}
                selected={selected}
                onStyle={setStyle}
                onAlign={(al) => selected && updateAnn(selected.id, { align: al } as any)}
                onDelete={selected ? deleteSelected : undefined}
                onDuplicate={selected ? () => duplicate(selected) : undefined}
                hint={toolHint(tool)}
              />
            </div>
          )}
          {searchOpen && (
            <div className="subbar search-bar">
              <Search size={16} color="var(--text-3)" />
              <input
                ref={searchInput}
                autoFocus
                placeholder="Find in document"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') stepMatch(e.shiftKey ? -1 : 1);
                  if (e.key === 'Escape') {
                    setSearchOpen(false);
                    setQuery('');
                  }
                }}
              />
              <span className="tb-label">{query ? (matches.length ? `${matchIdx + 1} of ${matches.length}` : 'No results') : ''}</span>
              <button className="icon-btn sm" onClick={() => stepMatch(-1)} disabled={!matches.length}>
                <ChevronUp size={16} />
              </button>
              <button className="icon-btn sm" onClick={() => stepMatch(1)} disabled={!matches.length}>
                <ChevronDown size={16} />
              </button>
              <button
                className="icon-btn sm"
                onClick={() => {
                  setSearchOpen(false);
                  setQuery('');
                }}
              >
                <X size={16} />
              </button>
            </div>
          )}
        </div>
      )}

      <div className="pdf-body">
        {sidebar && (
          <div className="side-panel">
            <div className="panel-head">
              <span>
                Pages <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· {pageCount}</span>
              </span>
              <div style={{ display: 'flex' }}>
                <button className="icon-btn sm" title="Rotate left" onClick={() => rotatePages(-90)}>
                  <RotateCcw size={15} />
                </button>
                <button className="icon-btn sm" title="Rotate right" onClick={() => rotatePages(90)}>
                  <RotateCw size={15} />
                </button>
                <button className="icon-btn sm" title="Delete page(s)" onClick={() => deletePages()}>
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
            <Thumbnails
              pages={doc.pages}
              docs={docs}
              sizeOf={sizeOf}
              selected={selectedPages}
              currentIndex={currentIndex}
              onSelect={(sel, i) => {
                setSelectedPages(sel);
                scrollToPage(i);
              }}
              onReorder={reorderPages}
              onContextMenu={(e, i) => {
                if (!selectedPages.has(doc.pages[i].id)) setSelectedPages(new Set([doc.pages[i].id]));
                setCurrentIndex(i);
                setPageMenu({ x: e.clientX, y: e.clientY });
              }}
            />
            <div className="thumb-actions">
              <button className="btn tonal sm" onClick={insertBlank} title="Insert blank page after current">
                <StickyNote size={14} /> Blank
              </button>
              <button className="btn tonal sm" onClick={insertFromFile} title="Insert PDF or images after current page">
                <FilePlus2 size={14} /> Insert
              </button>
            </div>
          </div>
        )}

        <div className={`pdf-scroll ${darkPages ? 'dark' : ''}`} ref={scrollRef} onScroll={onScroll}>
          {status === 'loading' ? (
            <div className="center-fill" style={{ height: '100%' }}>
              <div className="spinner" />
            </div>
          ) : (
            <div className="pdf-pages">
              {doc.pages.map((ref, i) => {
                const s = sizeOf(ref);
                return (
                  <PageView
                    key={ref.id}
                    doc={ref.src >= 0 ? docs[ref.src] : null}
                    pageRef={ref}
                    pageNumber={i + 1}
                    width={s.width}
                    height={s.height}
                    rotation={s.rotation}
                    scale={scale}
                    darkPages={darkPages}
                    annots={annotsByPage.get(ref.id) || NO_RECTS}
                    tool={tool}
                    style={currentStyle}
                    selectedId={selectedId}
                    editingId={editingId}
                    searchRects={searchRectsByPage.get(ref.id) || NO_RECTS}
                    scrollRoot={scrollRoot}
                    {...cb}
                  />
                );
              })}
            </div>
          )}
        </div>

        {formOpen && formFields.length > 0 && (
          <div className="side-panel right">
            <div className="panel-head">
              <span>Form fields</span>
              <button className="icon-btn sm" onClick={() => setFormOpen(false)}>
                <X size={15} />
              </button>
            </div>
            <div className="panel-body form-fields">
              {formFields.map((f) => {
                const v = formValues[f.name] ?? f.value;
                const set = (val: any) => {
                  setFormValues((fv) => ({ ...fv, [f.name]: val }));
                  markDirty();
                };
                return (
                  <div key={f.name} className="form-field">
                    <label className="field-label">{f.name}</label>
                    {f.type === 'text' &&
                      (f.multiline ? (
                        <textarea className="input" rows={3} value={String(v)} onChange={(e) => set(e.target.value)} />
                      ) : (
                        <input className="input sm" value={String(v)} onChange={(e) => set(e.target.value)} />
                      ))}
                    {f.type === 'checkbox' && (
                      <label className="check">
                        <input type="checkbox" checked={!!v} onChange={(e) => set(e.target.checked)} /> {v ? 'Checked' : 'Unchecked'}
                      </label>
                    )}
                    {(f.type === 'dropdown' || f.type === 'radio') && (
                      <select className="input sm" value={String(v)} onChange={(e) => set(e.target.value)}>
                        <option value="">—</option>
                        {f.options!.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    )}
                    {f.type === 'list' && (
                      <select className="input" multiple value={v as string[]} onChange={(e) => set(Array.from(e.target.selectedOptions).map((o) => o.value))}>
                        {f.options!.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
              <p className="empty-note" style={{ textAlign: 'left', padding: '8px 0' }}>
                Values are written into the PDF when you save.
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="statusbar">
        <span>
          Page{' '}
          <input
            className="num-input"
            value={currentIndex + 1}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (n >= 1 && n <= pageCount) scrollToPage(n - 1);
            }}
            onFocus={(e) => e.target.select()}
          />{' '}
          of {pageCount}
        </span>
        {selectedPages.size > 1 && <span>{selectedPages.size} pages selected</span>}
        <span className="grow" />
        {encrypted && <span style={{ color: 'var(--warning)' }}>Encrypted · view only</span>}
        <span>{toolHint(tool)}</span>
      </div>

      {pageMenu && (
        <>
          <div ref={setPageMenuAnchor} style={{ position: 'fixed', left: pageMenu.x, top: pageMenu.y, width: 1, height: 1 }} />
          <Popover anchor={pageMenuAnchor} open={!!pageMenuAnchor} onClose={() => (setPageMenu(null), setPageMenuAnchor(null))}>
            {(() => {
              const close = () => (setPageMenu(null), setPageMenuAnchor(null));
              const n = selectedPages.size || 1;
              return (
                <>
                  <div className="menu-title">{n > 1 ? `${n} pages` : `Page ${currentIndex + 1}`}</div>
                  <button className="menu-item" onClick={() => (rotatePages(90), close())}>
                    <RotateCw size={16} /> Rotate right
                  </button>
                  <button className="menu-item" onClick={() => (rotatePages(-90), close())}>
                    <RotateCcw size={16} /> Rotate left
                  </button>
                  <button className="menu-item" onClick={() => (duplicatePages(), close())}>
                    <Copy size={16} /> Duplicate
                  </button>
                  <button className="menu-item" onClick={() => (movePages(-1), close())}>
                    <ChevronUp size={16} /> Move up
                  </button>
                  <button className="menu-item" onClick={() => (movePages(1), close())}>
                    <ChevronDown size={16} /> Move down
                  </button>
                  <div className="menu-sep" />
                  <button className="menu-item" onClick={() => (insertBlank(), close())}>
                    <StickyNote size={16} /> Insert blank page after
                  </button>
                  <button className="menu-item" onClick={() => (insertFromFile(), close())}>
                    <FilePlus2 size={16} /> Insert from file after…
                  </button>
                  <button className="menu-item" onClick={() => (extractPages(), close())}>
                    <FileOutput size={16} /> Extract to new PDF
                  </button>
                  <div className="menu-sep" />
                  <button className="menu-item" onClick={() => (deletePages(), close())} style={{ color: 'var(--danger)' }}>
                    <Trash2 size={16} color="var(--danger)" /> Delete
                  </button>
                </>
              );
            })()}
          </Popover>
        </>
      )}

      {sigOpen && (
        <SignatureModal
          onCancel={() => setSigOpen(false)}
          onDone={(url) => {
            setSigOpen(false);
            placeImage(url, true);
          }}
        />
      )}
    </div>
  );
}

function toolHint(t: Tool): string {
  switch (t) {
    case 'select':
      return 'Select text to copy · click an edit to move it';
    case 'edittext':
      return 'Click any line of text to change it';
    case 'text':
      return 'Click anywhere to type';
    case 'highlight':
    case 'underline':
    case 'strike':
      return 'Select text, or drag over an area';
    case 'ink':
      return 'Draw freely on the page';
    case 'whiteout':
      return 'Drag to cover content';
    case 'note':
      return 'Click to add a comment';
    case 'line':
    case 'arrow':
      return 'Drag to draw · hold Shift to snap angles';
    default:
      return 'Drag to draw · hold Shift for a perfect square/circle';
  }
}

function OptionsBar({
  type,
  style,
  selected,
  onStyle,
  onAlign,
  onDelete,
  onDuplicate,
  hint
}: {
  type: string;
  style: ToolStyle;
  selected: Annotation | null;
  onStyle(p: Partial<ToolStyle>): void;
  onAlign(a: TextAnn['align']): void;
  onDelete?: () => void;
  onDuplicate?: () => void;
  hint: string;
}) {
  const isText = type === 'text' || type === 'edittext';
  const isShape = type === 'rect' || type === 'ellipse';
  const hasStroke = isShape || type === 'ink' || type === 'line' || type === 'arrow';
  const hasColor = type !== 'whiteout' && type !== 'image';
  const hasOpacity = hasStroke || type === 'highlight';
  const align = selected?.type === 'text' ? selected.align : 'left';

  return (
    <>
      {hasColor && <ColorPicker title={isText ? 'Text color' : 'Color'} icon={isText ? <Type size={16} /> : <Palette size={16} />} value={style.color} onChange={(c) => c && onStyle({ color: c })} />}
      {(isShape || type === 'whiteout' || (isText && selected)) && (
        <ColorPicker
          title={type === 'whiteout' ? 'Cover color' : isText ? 'Background' : 'Fill'}
          icon={<PaintBucket size={16} />}
          value={style.fill}
          allowNone={type !== 'whiteout'}
          noneLabel="No fill"
          onChange={(c) => onStyle({ fill: c })}
        />
      )}
      {isText && (
        <>
          <select className="select" value={style.font} onChange={(e) => onStyle({ font: e.target.value as any })} title="Font">
            <option value="Helvetica">Sans (Helvetica)</option>
            <option value="Times">Serif (Times)</option>
            <option value="Courier">Mono (Courier)</option>
          </select>
          <FontSizeInput value={style.fontSize} onChange={(v) => onStyle({ fontSize: v })} />
          <button className={`icon-btn sm ${style.bold ? 'active' : ''}`} title="Bold" onClick={() => onStyle({ bold: !style.bold })}>
            <Bold size={16} />
          </button>
          <button className={`icon-btn sm ${style.italic ? 'active' : ''}`} title="Italic" onClick={() => onStyle({ italic: !style.italic })}>
            <Italic size={16} />
          </button>
          {selected && (
            <>
              <button className={`icon-btn sm ${align === 'left' ? 'active' : ''}`} onClick={() => onAlign('left')} title="Align left">
                <AlignLeft size={16} />
              </button>
              <button className={`icon-btn sm ${align === 'center' ? 'active' : ''}`} onClick={() => onAlign('center')} title="Center">
                <AlignCenter size={16} />
              </button>
              <button className={`icon-btn sm ${align === 'right' ? 'active' : ''}`} onClick={() => onAlign('right')} title="Align right">
                <AlignRight size={16} />
              </button>
            </>
          )}
        </>
      )}
      {hasStroke && (
        <label className="slider" title="Thickness">
          <span>Size</span>
          <input type="range" min={0.5} max={20} step={0.5} value={style.strokeWidth} onChange={(e) => onStyle({ strokeWidth: +e.target.value })} />
          <span className="val">{style.strokeWidth}</span>
        </label>
      )}
      {hasOpacity && (
        <label className="slider" title="Opacity">
          <span>Opacity</span>
          <input type="range" min={0.1} max={1} step={0.05} value={style.opacity} onChange={(e) => onStyle({ opacity: +e.target.value })} />
          <span className="val">{Math.round(style.opacity * 100)}%</span>
        </label>
      )}
      {!selected && <span className="tb-label">{hint}</span>}
      <div className="tb-spacer" />
      {onDuplicate && (
        <button className="icon-btn sm" title="Duplicate (Ctrl+D)" onClick={onDuplicate}>
          <Copy size={16} />
        </button>
      )}
      {onDelete && (
        <button className="icon-btn sm" title="Delete (Del)" onClick={onDelete}>
          <Trash2 size={16} />
        </button>
      )}
    </>
  );
}

function FontSizeInput({ value, onChange }: { value: number; onChange(v: number): void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(Math.round(value * 10) / 10)), [value]);
  const commit = (v: number) => {
    const n = clamp(Math.round(v * 10) / 10, 4, 200);
    onChange(n);
    setText(String(n));
  };
  return (
    <div className="size-input">
      <button className="icon-btn sm" onClick={() => commit(value - 1)}>
        <Minus size={14} />
      </button>
      <input
        className="num-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(parseFloat(text) || value)}
        onKeyDown={(e) => e.key === 'Enter' && commit(parseFloat(text) || value)}
      />
      <button className="icon-btn sm" onClick={() => commit(value + 1)}>
        <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
      </button>
    </div>
  );
}

// Re-exported for the print helper.
export { escapeHtml };

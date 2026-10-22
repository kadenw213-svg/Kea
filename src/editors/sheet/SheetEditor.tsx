import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Undo2,
  Redo2,
  Bold,
  Italic,
  Strikethrough,
  Underline as UIcon,
  Baseline,
  PaintBucket,
  AlignLeft,
  AlignCenter,
  AlignRight,
  WrapText,
  DollarSign,
  Percent,
  Save,
  MoreVertical,
  Search,
  Plus,
  ArrowDownAZ,
  ArrowUpAZ,
  Sigma,
  Snowflake,
  TableCellsMerge,
  Rows3,
  Columns3,
  Trash2,
  Copy,
  Scissors,
  ClipboardPaste,
  Eraser,
  FileDown,
  Printer,
  X,
  ChevronUp,
  ChevronDown,
  Pencil,
  Grid3x3,
  BarChart3,
  Filter as FilterIcon,
  Database,
  ListChecks,
  Paintbrush,
  CopyMinus,
  TableProperties,
  ChevronDown as Caret
} from 'lucide-react';
import type { Chart, Border, Validation, CondRule, FilterState } from './model';
import { chartData, chartSvg } from './chart';
import { conditionalFormats, CfResult, currentRegion, filteredRows, validationAt, listItems, invalidReason } from './features';
import { ChartDialog, CondFormatDialog, ValidationDialog, FilterMenu, PivotDialog } from './SheetDialogs';
import { uid } from '../../lib/util';
import { useSetting } from '../../lib/settings';
import type { Tab } from '../../store';
import { editorRegistry, setDirty, toast, ask, prompt } from '../../store';
import {
  Workbook,
  Sheet,
  Cell,
  CellStyle,
  NumFmt,
  Calc,
  key,
  parseKey,
  newSheet,
  usedRange,
  parseInput,
  editText,
  formatValue,
  DEFAULT_COL_W,
  DEFAULT_ROW_H,
  HEADER_H,
  HEADER_W,
  MIN_COLS,
  MIN_ROWS
} from './model';
import { colName, addr, parseAddr, shiftFormula, adjustForInsert, renameSheetRefs, FormulaError, FUNCTION_NAMES, formulaRefs, compare, dateToSerial } from './formula';
import { readWorkbook, writeXlsx, writeCsv, writeOds, parseCsv } from './io';
import { saveTabFile, exportFile, SaveFormat, isSilentSave } from '../../lib/save';
import { extOf, baseName } from '../../lib/fileTypes';
import { api } from '../../lib/api';
import { clamp, escapeHtml, modKey } from '../../lib/util';
import { MenuButton, Popover } from '../../components/Popover';
import { ColorPicker } from '../../components/ColorPicker';
import './sheet.css';
import { LookupButton } from '../../components/lookup/LookupButton';
import { AssistantButton } from '../../components/assistant/AssistantPanel';
import { publishSelection } from '../../components/lookup/lookupStore';
import { proxyAi, AiHooks } from '../../store';

interface Pos {
  r: number;
  c: number;
}
interface Range {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}
const norm = (a: Pos, b: Pos): Range => ({ r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) });
const inRange = (r: number, c: number, g: Range) => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2;
const REF_COLORS = ['#8ab4f8', '#f28b82', '#81c995', '#fdd663', '#c58af9', '#78d9ec'];

function useHistory<T>(initial: T) {
  const state = useRef<T>(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const [version, force] = useReducer((x) => x + 1, 0);
  const api = useMemo(
    () => ({
      get: () => state.current,
      reset(s: T) {
        state.current = s;
        past.current = [];
        future.current = [];
        force();
      },
      commit(s: T) {
        past.current.push(state.current);
        if (past.current.length > 300) past.current.shift();
        future.current = [];
        state.current = s;
        force();
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
  return { ...api, version };
}

export default function SheetEditor({ tab, active }: { tab: Tab; active: boolean }) {
  const [wb0, setWb0] = useState<Workbook | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    (async () => {
      try {
        if (!tab.data) setWb0({ sheets: [newSheet('Sheet1')] });
        else setWb0(await readWorkbook(tab.name, tab.data));
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
          <h3 style={{ color: 'var(--text)', fontWeight: 500 }}>Couldn't open this spreadsheet</h3>
          <p>{error}</p>
        </div>
      </div>
    );
  if (!wb0)
    return (
      <div className="center-fill">
        <div className="spinner" />
      </div>
    );
  return <SheetEditorInner tab={tab} active={active} initial={wb0} />;
}

function SheetEditorInner({ tab, active, initial }: { tab: Tab; active: boolean; initial: Workbook }) {
  const h = useHistory<Workbook>(initial);
  const wb = h.get();
  const [si, setSi] = useState(0);
  const sheet = wb.sheets[Math.min(si, wb.sheets.length - 1)];
  const calc = useMemo(() => new Calc(wb), [wb]);

  const [cur, setCur] = useState<Pos>({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState<Pos>({ r: 0, c: 0 });
  const sel = norm(anchor, cur);
  const [editing, setEditing] = useState<{ r: number; c: number; text: string; mode: 'enter' | 'edit'; bar: boolean } | null>(null);
  const [extraRows, setExtraRows] = useState(0);
  const [extraCols, setExtraCols] = useState(0);
  const [view, setView] = useState({ r0: 0, r1: 40, c0: 0, c1: 15 });
  const [findOpen, setFindOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'cell' | 'tab'; index?: number } | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLDivElement | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [fillPreview, setFillPreview] = useState<Range | null>(null);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const [chartEdit, setChartEdit] = useState<{ chart: Chart; isNew: boolean } | null>(null);
  const [selChart, setSelChart] = useState<string | null>(null);
  const [dlg, setDlg] = useState<null | 'cf' | 'validation' | 'pivot'>(null);
  const [filterMenu, setFilterMenu] = useState<{ col: number; x: number; y: number } | null>(null);
  const [dropdown, setDropdown] = useState<{ r: number; c: number; x: number; y: number } | null>(null);
  const showGrid = useSetting<boolean>('sheet.gridlines');
  const enterMoves = useSetting<string>('sheet.enterMoves');
  const gridFont = Number(useSetting('sheet.fontSize')) || 13;
  const autocomplete = useSetting<boolean>('sheet.autocomplete');
  const showStats = useSetting<boolean>('sheet.stats');
  const enterStep = (back: boolean) => {
    const s = back ? -1 : 1;
    return enterMoves === 'right' ? { dr: 0, dc: s } : enterMoves === 'none' ? { dr: 0, dc: 0 } : { dr: s, dc: 0 };
  };

  const bodyRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLInputElement>(null);
  const clip = useRef<{ text: string; sheetId: string; range: Range; cells: Record<string, Cell>; cut: boolean } | null>(null);
  const drag = useRef<any>(null);

  const used = useMemo(() => usedRange(sheet), [sheet.cells]);
  const cf = useMemo(() => conditionalFormats(sheet, calc), [sheet, calc]);
  const checkboxAt = useMemo(() => {
    const ranges = (sheet.validations || []).filter((v) => v.type === 'checkbox').map((v) => v.range);
    return (r: number, c: number) => ranges.some((g) => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2);
  }, [sheet.validations]);
  const rows = Math.max(MIN_ROWS, used.rows + 100) + extraRows;
  const cols = Math.max(MIN_COLS, used.cols + 5) + extraCols;

  // ---------- Geometry ----------
  const geo = useMemo(() => {
    const colStart = new Float64Array(cols + 1);
    for (let c = 0; c < cols; c++) colStart[c + 1] = colStart[c] + (sheet.colW[c] ?? DEFAULT_COL_W);
    const rowStart = new Float64Array(rows + 1);
    const hiddenR = sheet.hiddenRows || {};
    for (let r = 0; r < rows; r++) rowStart[r + 1] = rowStart[r] + (hiddenR[r] ? 0 : sheet.rowH[r] ?? DEFAULT_ROW_H);
    const find = (arr: Float64Array, v: number, n: number) => {
      let lo = 0,
        hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (arr[mid] <= v) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    return {
      colStart,
      rowStart,
      cw: (c: number) => colStart[c + 1] - colStart[c],
      rh: (r: number) => rowStart[r + 1] - rowStart[r],
      findCol: (x: number) => find(colStart, Math.max(0, x), cols),
      findRow: (y: number) => find(rowStart, Math.max(0, y), rows),
      totalW: colStart[cols],
      totalH: rowStart[rows]
    };
  }, [sheet.colW, sheet.rowH, sheet.hiddenRows, rows, cols]);

  const fz = sheet.freeze;
  const frozenW = geo.colStart[fz.cols];
  const frozenH = geo.rowStart[fz.rows];

  // Merged cell lookup
  const mergeAt = useMemo(() => {
    const m = new Map<string, Range>();
    for (const g of sheet.merges || []) for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) m.set(key(r, c), g);
    return m;
  }, [sheet.merges]);

  // ---------- Scrolling / virtualisation ----------
  const updateView = useCallback(() => {
    const b = bodyRef.current;
    // A hidden tab measures 0×0, which looks like "scrolled to the end" and would add rows forever.
    if (!b || !b.clientHeight || !b.clientWidth) return;
    b.style.setProperty('--sx', `${b.scrollLeft}px`);
    b.style.setProperty('--sy', `${b.scrollTop}px`);
    const vw = b.clientWidth - HEADER_W,
      vh = b.clientHeight - HEADER_H;
    const r0 = Math.max(fz.rows, geo.findRow(b.scrollTop + frozenH) - 8);
    const r1 = Math.min(rows - 1, geo.findRow(b.scrollTop + vh) + 10);
    const c0 = Math.max(fz.cols, geo.findCol(b.scrollLeft + frozenW) - 3);
    const c1 = Math.min(cols - 1, geo.findCol(b.scrollLeft + vw) + 4);
    setView((v) => {
      // Keep the current window while the visible area is still inside it (fewer re-renders while scrolling).
      const vr0 = geo.findRow(b.scrollTop + frozenH),
        vr1 = geo.findRow(b.scrollTop + vh),
        vc0 = geo.findCol(b.scrollLeft + frozenW),
        vc1 = geo.findCol(b.scrollLeft + vw);
      const inside = v.r0 <= Math.max(fz.rows, vr0 - 1) && v.r1 >= Math.min(rows - 1, vr1 + 1) && v.c0 <= Math.max(fz.cols, vc0) && v.c1 >= Math.min(cols - 1, vc1 + 1);
      return inside ? v : { r0, r1, c0, c1 };
    });
    if (b.scrollTop + b.clientHeight > b.scrollHeight - 300) setExtraRows((x) => x + 100);
    if (b.scrollLeft + b.clientWidth > b.scrollWidth - 300) setExtraCols((x) => x + 10);
  }, [geo, rows, cols, fz.rows, fz.cols, frozenW, frozenH]);

  useLayoutEffect(() => updateView(), [updateView]);
  useEffect(() => {
    const ro = new ResizeObserver(() => updateView());
    if (bodyRef.current) ro.observe(bodyRef.current);
    return () => ro.disconnect();
  }, [updateView]);

  const scrollIntoView = (p: Pos) => {
    const b = bodyRef.current;
    if (!b) return;
    const x = geo.colStart[p.c],
      y = geo.rowStart[p.r];
    const w = geo.cw(p.c),
      hh = geo.rh(p.r);
    const vw = b.clientWidth - HEADER_W - frozenW,
      vh = b.clientHeight - HEADER_H - frozenH;
    if (p.c >= fz.cols) {
      if (x - frozenW < b.scrollLeft) b.scrollLeft = x - frozenW;
      else if (x + w - frozenW > b.scrollLeft + vw) b.scrollLeft = x + w - frozenW - vw;
    }
    if (p.r >= fz.rows) {
      if (y - frozenH < b.scrollTop) b.scrollTop = y - frozenH;
      else if (y + hh - frozenH > b.scrollTop + vh) b.scrollTop = y + hh - frozenH - vh;
    }
  };

  // ---------- Mutations ----------
  const markDirty = () => setDirty(tab.id, true);
  const commitSheet = (fn: (s: Sheet) => void, idx = si) => {
    const w = h.get();
    const sheets = [...w.sheets];
    const s: Sheet = { ...sheets[idx], cells: { ...sheets[idx].cells }, colW: { ...sheets[idx].colW }, rowH: { ...sheets[idx].rowH }, merges: sheets[idx].merges ? [...sheets[idx].merges!] : undefined };
    fn(s);
    sheets[idx] = s;
    h.commit({ sheets });
    markDirty();
  };

  const setInput = (r: number, c: number, text: string) => {
    commitSheet((s) => {
      const k = key(r, c);
      const prev = s.cells[k];
      const { cell, fmt } = parseInput(text, prev?.s);
      const style = fmt ? { ...(prev?.s || {}), ...fmt } : prev?.s;
      const next: Cell = { ...cell, ...(style ? { s: style } : {}) };
      if (next.v === undefined && next.f === undefined && !next.s) delete s.cells[k];
      else s.cells[k] = next;
    });
  };

  const eachInSel = (fn: (r: number, c: number) => void, range = sel) => {
    const r2 = Math.min(range.r2, Math.max(used.rows - 1, range.r1, Math.min(range.r2, rows - 1)));
    const c2 = Math.min(range.c2, cols - 1);
    for (let r = range.r1; r <= r2; r++) for (let c = range.c1; c <= c2; c++) fn(r, c);
  };

  const applyStyle = (patch: Partial<CellStyle> | ((s: CellStyle) => Partial<CellStyle>)) => {
    commitSheet((s) => {
      eachInSel((r, c) => {
        const k = key(r, c);
        const prev = s.cells[k] || {};
        const p = typeof patch === 'function' ? patch(prev.s || {}) : patch;
        const style: any = { ...(prev.s || {}), ...p };
        for (const kk of Object.keys(style)) if (style[kk] === undefined || style[kk] === null || style[kk] === false) delete style[kk];
        const next: Cell = { ...prev, s: Object.keys(style).length ? style : undefined };
        if (!next.s) delete next.s;
        if (next.v === undefined && next.f === undefined && !next.s) delete s.cells[k];
        else s.cells[k] = next;
      });
    });
  };

  const clearRange = (range = sel, what: 'contents' | 'all' = 'contents') => {
    commitSheet((s) => {
      eachInSel((r, c) => {
        const k = key(r, c);
        const prev = s.cells[k];
        if (!prev) return;
        if (what === 'all' || !prev.s) delete s.cells[k];
        else s.cells[k] = { s: prev.s };
      }, range);
    });
  };

  const activeCell = sheet.cells[key(cur.r, cur.c)];
  const activeStyle = activeCell?.s || {};

  // ---------- Selection & navigation ----------
  const select = (p: Pos, extend = false) => {
    const q = { r: clamp(p.r, 0, rows - 1), c: clamp(p.c, 0, cols - 1) };
    setCur(q);
    if (!extend) setAnchor(q);
    scrollIntoView(q);
  };

  const hasValue = (r: number, c: number) => {
    const cell = sheet.cells[key(r, c)];
    return !!cell && (cell.f !== undefined || (cell.v !== undefined && cell.v !== null && cell.v !== ''));
  };
  /** Ctrl+Arrow: jump to the edge of the current data block. */
  const jump = (p: Pos, dr: number, dc: number): Pos => {
    let { r, c } = p;
    const inside = (rr: number, cc: number) => rr >= 0 && cc >= 0 && rr < rows && cc < cols;
    if (!inside(r + dr, c + dc)) return p;
    if (hasValue(r, c) && hasValue(r + dr, c + dc)) {
      while (inside(r + dr, c + dc) && hasValue(r + dr, c + dc)) {
        r += dr;
        c += dc;
      }
      return { r, c };
    }
    r += dr;
    c += dc;
    while (inside(r, c) && !hasValue(r, c)) {
      if (!inside(r + dr, c + dc)) return { r, c };
      if (dr > 0 && r >= used.rows) return { r: Math.max(p.r, used.rows ? rows - 1 : p.r), c };
      if (dc > 0 && c >= used.cols) return { r, c: cols - 1 };
      r += dr;
      c += dc;
    }
    return { r: clamp(r, 0, rows - 1), c: clamp(c, 0, cols - 1) };
  };

  // ---------- Editing ----------
  const startEdit = (initial?: string, bar = false) => {
    const m = mergeAt.get(key(cur.r, cur.c));
    const r = m ? m.r1 : cur.r,
      c = m ? m.c1 : cur.c;
    setEditing({ r, c, text: initial ?? editText(sheet.cells[key(r, c)]), mode: initial !== undefined ? 'enter' : 'edit', bar });
    setSuggestIdx(0);
  };
  const commitEdit = (move?: { dr: number; dc: number }) => {
    if (!editing) return;
    let text = editing.text;
    // Auto-close parentheses in formulas.
    if (text.startsWith('=')) {
      const open = (text.match(/\(/g) || []).length - (text.match(/\)/g) || []).length;
      if (open > 0) text += ')'.repeat(open);
    }
    const rule = validationAt(sheet, editing.r, editing.c);
    const problem = rule && !text.startsWith('=') ? invalidReason(rule, text.trim(), wb, calc, sheet) : null;
    if (problem && rule!.strict) {
      toast(problem, 'error');
      return;
    }
    if (problem) toast(problem);
    if (text !== editText(sheet.cells[key(editing.r, editing.c)])) setInput(editing.r, editing.c, text);
    setEditing(null);
    bodyRef.current?.focus();
    if (move) select({ r: editing.r + move.dr, c: editing.c + move.dc });
  };
  const cancelEdit = () => {
    setEditing(null);
    bodyRef.current?.focus();
  };

  useEffect(() => {
    if (!editing) return;
    const el = editing.bar ? barRef.current : editorRef.current;
    if (el && document.activeElement !== el) {
      el.focus();
      const n = el.value.length;
      el.setSelectionRange(n, n);
    }
  }, [editing?.r, editing?.c, editing?.bar]);

  // Function-name suggestions while typing a formula.
  const suggestions = useMemo(() => {
    if (!autocomplete || !editing || !editing.text.startsWith('=')) return [];
    const m = editing.text.match(/([A-Za-z][A-Za-z0-9.]*)$/);
    if (!m || m[1].length < 1) return [];
    const pre = m[1].toUpperCase();
    if (/^[A-Z]{1,3}\d+$/.test(pre)) return [];
    return FUNCTION_NAMES.filter((f) => f.startsWith(pre) && f !== pre).slice(0, 8);
  }, [editing?.text]);

  const acceptSuggestion = (name: string) => {
    if (!editing) return;
    const text = editing.text.replace(/([A-Za-z][A-Za-z0-9.]*)$/, name + '(');
    setEditing({ ...editing, text });
    setTimeout(() => {
      const el = editing.bar ? barRef.current : editorRef.current;
      el?.focus();
      el?.setSelectionRange(text.length, text.length);
    });
  };

  /** While typing a formula, clicking a cell inserts its reference. */
  const formulaPicking = () => {
    if (!editing || !editing.text.startsWith('=')) return false;
    const el = editing.bar ? barRef.current : editorRef.current;
    const pos = el?.selectionStart ?? editing.text.length;
    const before = editing.text.slice(0, pos).trimEnd();
    return /[=(+\-*/^&,<>:;]$/.test(before) || drag.current?.mode === 'pick';
  };

  // ---------- Hit testing ----------
  const hit = (clientX: number, clientY: number) => {
    const b = bodyRef.current!;
    const rect = b.getBoundingClientRect();
    const vx = clientX - rect.left,
      vy = clientY - rect.top;
    const gx = vx - HEADER_W < frozenW ? vx - HEADER_W : vx - HEADER_W + b.scrollLeft;
    const gy = vy - HEADER_H < frozenH ? vy - HEADER_H : vy - HEADER_H + b.scrollTop;
    const c = geo.findCol(gx),
      r = geo.findRow(gy);
    const area = vy < HEADER_H && vx < HEADER_W ? 'corner' : vy < HEADER_H ? 'colh' : vx < HEADER_W ? 'rowh' : 'cell';
    return { r, c, gx, gy, area, vx, vy };
  };

  // ---------- Mouse ----------
  const onMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.cell-editor') || target.closest('.suggest') || target.closest('.chart-box') || target.closest('.flt-btn') || target.closest('.dd-btn')) return;
    setSelChart(null);
    const cbEl = target.closest('[data-cb]') as HTMLElement | null;
    if (cbEl && e.button === 0) {
      const [r, c] = cbEl.dataset.cb!.split(',').map(Number);
      const v = calc.value(sheet, r, c);
      setInput(r, c, v === true ? 'FALSE' : 'TRUE');
      select({ r, c });
      e.preventDefault();
      return;
    }
    const hh = hit(e.clientX, e.clientY);
    if (e.button === 2) {
      if (hh.area === 'cell' && !inRange(hh.r, hh.c, sel)) select({ r: hh.r, c: hh.c });
      return;
    }
    if (target.dataset.fill) {
      e.preventDefault();
      drag.current = { mode: 'fill', start: { ...sel } };
      return;
    }
    if (hh.area === 'colh') {
      const nearRight = Math.abs(hh.gx - geo.colStart[hh.c + 1]) < 5;
      const nearLeft = hh.c > 0 && Math.abs(hh.gx - geo.colStart[hh.c]) < 5;
      if (nearRight || nearLeft) {
        e.preventDefault();
        const c = nearRight ? hh.c : hh.c - 1;
        drag.current = { mode: 'colresize', c, startX: e.clientX, startW: geo.cw(c) };
        return;
      }
    }
    if (hh.area === 'rowh') {
      const nearBottom = Math.abs(hh.gy - geo.rowStart[hh.r + 1]) < 4;
      const nearTop = hh.r > 0 && Math.abs(hh.gy - geo.rowStart[hh.r]) < 4;
      if (nearBottom || nearTop) {
        e.preventDefault();
        const r = nearBottom ? hh.r : hh.r - 1;
        drag.current = { mode: 'rowresize', r, startY: e.clientY, startH: geo.rh(r) };
        return;
      }
    }
    if (editing && hh.area === 'cell' && formulaPicking()) {
      e.preventDefault();
      const el = editing.bar ? barRef.current : editorRef.current;
      const pos = el?.selectionStart ?? editing.text.length;
      const ref = addr(hh.r, hh.c);
      const text = editing.text.slice(0, pos) + ref + editing.text.slice(pos);
      setEditing({ ...editing, text });
      drag.current = { mode: 'pick', start: { r: hh.r, c: hh.c }, insertAt: pos, base: editing.text };
      setTimeout(() => {
        el?.focus();
        el?.setSelectionRange(pos + ref.length, pos + ref.length);
      });
      return;
    }
    if (editing) commitEdit();
    e.preventDefault();
    bodyRef.current?.focus();
    if (hh.area === 'corner') {
      setAnchor({ r: 0, c: 0 });
      setCur({ r: rows - 1, c: cols - 1 });
      return;
    }
    if (hh.area === 'colh') {
      setAnchor({ r: 0, c: e.shiftKey ? anchor.c : hh.c });
      setCur({ r: rows - 1, c: hh.c });
      drag.current = { mode: 'cols' };
      return;
    }
    if (hh.area === 'rowh') {
      setAnchor({ r: e.shiftKey ? anchor.r : hh.r, c: 0 });
      setCur({ r: hh.r, c: cols - 1 });
      drag.current = { mode: 'rows' };
      return;
    }
    const m = mergeAt.get(key(hh.r, hh.c));
    const p = m ? { r: m.r1, c: m.c1 } : { r: hh.r, c: hh.c };
    if (e.shiftKey) setCur(p);
    else {
      setCur(m ? { r: m.r2, c: m.c2 } : p);
      setAnchor(p);
      if (m) setTimeout(() => setCur(p));
    }
    drag.current = { mode: 'select' };
    if (e.detail === 2) setTimeout(() => startEdit(), 0);
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d || !bodyRef.current) return;
      const hh = hit(e.clientX, e.clientY);
      if (d.mode === 'select') setCur({ r: hh.r, c: hh.c });
      else if (d.mode === 'cols') setCur((p) => ({ ...p, c: hh.c }));
      else if (d.mode === 'rows') setCur((p) => ({ ...p, r: hh.r }));
      else if (d.mode === 'colresize') {
        const w = Math.max(24, d.startW + e.clientX - d.startX);
        d.w = w;
        bodyRef.current.style.setProperty('--resize-x', `${HEADER_W + geo.colStart[d.c] + w}px`);
        bodyRef.current.classList.add('resizing-col');
      } else if (d.mode === 'rowresize') {
        const hgt = Math.max(16, d.startH + e.clientY - d.startY);
        d.h = hgt;
        bodyRef.current.style.setProperty('--resize-y', `${HEADER_H + geo.rowStart[d.r] + hgt}px`);
        bodyRef.current.classList.add('resizing-row');
      } else if (d.mode === 'pick' && editing) {
        const range = norm(d.start, { r: hh.r, c: hh.c });
        const ref = range.r1 === range.r2 && range.c1 === range.c2 ? addr(range.r1, range.c1) : `${addr(range.r1, range.c1)}:${addr(range.r2, range.c2)}`;
        const text = d.base.slice(0, d.insertAt) + ref + d.base.slice(d.insertAt);
        setEditing((ed) => (ed ? { ...ed, text } : ed));
        d.end = d.insertAt + ref.length;
      } else if (d.mode === 'fill') {
        const s: Range = d.start;
        const downBy = hh.r - s.r2,
          upBy = s.r1 - hh.r,
          rightBy = hh.c - s.c2,
          leftBy = s.c1 - hh.c;
        const best = Math.max(downBy, upBy, rightBy, leftBy);
        let g: Range | null = null;
        if (best > 0) {
          if (best === downBy) g = { ...s, r2: hh.r };
          else if (best === upBy) g = { ...s, r1: hh.r };
          else if (best === rightBy) g = { ...s, c2: hh.c };
          else g = { ...s, c1: hh.c };
        }
        d.target = g;
        setFillPreview(g);
      }
      // Auto-scroll while dragging near the edges.
      const b = bodyRef.current.getBoundingClientRect();
      if (['select', 'fill', 'pick', 'cols', 'rows'].includes(d.mode)) {
        if (e.clientY > b.bottom - 20) bodyRef.current.scrollTop += 20;
        if (e.clientY < b.top + HEADER_H + 10) bodyRef.current.scrollTop -= 20;
        if (e.clientX > b.right - 20) bodyRef.current.scrollLeft += 20;
        if (e.clientX < b.left + HEADER_W + 10) bodyRef.current.scrollLeft -= 20;
      }
    };
    const onUp = () => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      bodyRef.current?.classList.remove('resizing-col', 'resizing-row');
      if (d.mode === 'colresize' && d.w) commitSheet((s) => void (s.colW[d.c] = Math.round(d.w)));
      if (d.mode === 'rowresize' && d.h) commitSheet((s) => void (s.rowH[d.r] = Math.round(d.h)));
      if (d.mode === 'pick') {
        const el = editing?.bar ? barRef.current : editorRef.current;
        if (d.end) setTimeout(() => (el?.focus(), el?.setSelectionRange(d.end, d.end)));
      }
      if (d.mode === 'fill') {
        setFillPreview(null);
        if (d.target) doFill(d.start, d.target);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  });

  const onDoubleClickHeader = (e: React.MouseEvent) => {
    const hh = hit(e.clientX, e.clientY);
    if (hh.area !== 'colh') return;
    const nearRight = Math.abs(hh.gx - geo.colStart[hh.c + 1]) < 5;
    if (!nearRight) return;
    autoFit(hh.c);
  };

  const autoFit = (c: number) => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    let w = 40;
    for (let r = 0; r < used.rows; r++) {
      const cell = sheet.cells[key(r, c)];
      if (!cell) continue;
      ctx.font = `${cell.s?.b ? '600 ' : ''}${cell.s?.size ? Math.round(cell.s.size * 1.333) : 13}px Inter, Segoe UI, sans-serif`;
      w = Math.max(w, ctx.measureText(formatValue(calc.value(sheet, r, c), cell.s)).width + 14);
    }
    commitSheet((s) => void (s.colW[c] = Math.min(600, Math.ceil(w))));
  };

  // ---------- Fill ----------
  const doFill = (src: Range, target: Range) => {
    commitSheet((s) => {
      const vertical = target.r1 !== src.r1 || target.r2 !== src.r2;
      const srcCells = (r: number, c: number) => sheet.cells[key(r, c)];
      if (vertical) {
        const n = src.r2 - src.r1 + 1;
        for (let c = src.c1; c <= src.c2; c++) {
          const nums = Array.from({ length: n }, (_, i) => srcCells(src.r1 + i, c)).map((x) => (x && x.f === undefined && typeof x.v === 'number' ? x.v : null));
          const series = n >= 2 && nums.every((x) => x !== null);
          const step = series ? (nums[n - 1]! - nums[0]!) / (n - 1) : 0;
          for (let r = target.r1; r <= target.r2; r++) {
            if (r >= src.r1 && r <= src.r2) continue;
            const offset = r > src.r2 ? r - src.r2 : r - src.r1;
            const from = r > src.r2 ? src.r1 + ((r - src.r1) % n) : src.r2 - ((src.r2 - r) % n);
            const base = srcCells(from, c);
            const k = key(r, c);
            if (!base) {
              delete s.cells[k];
              continue;
            }
            if (series) s.cells[k] = { ...base, v: r > src.r2 ? nums[n - 1]! + step * offset : nums[0]! + step * offset };
            else if (base.f !== undefined) s.cells[k] = { ...base, f: shiftFormula(base.f, r - from, 0) };
            else s.cells[k] = { ...base };
          }
        }
      } else {
        const n = src.c2 - src.c1 + 1;
        for (let r = src.r1; r <= src.r2; r++) {
          const nums = Array.from({ length: n }, (_, i) => srcCells(r, src.c1 + i)).map((x) => (x && x.f === undefined && typeof x.v === 'number' ? x.v : null));
          const series = n >= 2 && nums.every((x) => x !== null);
          const step = series ? (nums[n - 1]! - nums[0]!) / (n - 1) : 0;
          for (let c = target.c1; c <= target.c2; c++) {
            if (c >= src.c1 && c <= src.c2) continue;
            const offset = c > src.c2 ? c - src.c2 : c - src.c1;
            const from = c > src.c2 ? src.c1 + ((c - src.c1) % n) : src.c2 - ((src.c2 - c) % n);
            const base = srcCells(r, from);
            const k = key(r, c);
            if (!base) {
              delete s.cells[k];
              continue;
            }
            if (series) s.cells[k] = { ...base, v: c > src.c2 ? nums[n - 1]! + step * offset : nums[0]! + step * offset };
            else if (base.f !== undefined) s.cells[k] = { ...base, f: shiftFormula(base.f, 0, c - from) };
            else s.cells[k] = { ...base };
          }
        }
      }
    });
    setAnchor({ r: target.r1, c: target.c1 });
    setCur({ r: target.r2, c: target.c2 });
  };

  // ---------- Clipboard ----------
  const rangeTsv = (g: Range) => {
    const r2 = Math.min(g.r2, Math.max(used.rows - 1, g.r1));
    const c2 = Math.min(g.c2, Math.max(used.cols - 1, g.c1));
    const lines: string[] = [];
    for (let r = g.r1; r <= r2; r++) {
      const row: string[] = [];
      for (let c = g.c1; c <= c2; c++) {
        let v = formatValue(calc.value(sheet, r, c), sheet.cells[key(r, c)]?.s);
        if (/[\t\n"]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
        row.push(v);
      }
      lines.push(row.join('\t'));
    }
    return lines.join('\n');
  };

  const copy = (cut = false) => {
    const g = { ...sel, r2: Math.min(sel.r2, Math.max(used.rows - 1, sel.r1)), c2: Math.min(sel.c2, Math.max(used.cols - 1, sel.c1)) };
    const cells: Record<string, Cell> = {};
    for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) {
      const cell = sheet.cells[key(r, c)];
      if (cell) cells[key(r - g.r1, c - g.c1)] = cell;
    }
    const text = rangeTsv(g);
    clip.current = { text, sheetId: sheet.id, range: g, cells, cut };
    return text;
  };

  const paste = (text: string, html?: string) => {
    const internal = clip.current && clip.current.text === text ? clip.current : null;
    if (internal) {
      const { range, cells, cut } = internal;
      const hgt = range.r2 - range.r1 + 1,
        wid = range.c2 - range.c1 + 1;
      // Paste repeats to fill a larger selection that is a multiple of the copied size.
      const repR = (sel.r2 - sel.r1 + 1) % hgt === 0 && sel.r2 > sel.r1 ? (sel.r2 - sel.r1 + 1) / hgt : 1;
      const repC = (sel.c2 - sel.c1 + 1) % wid === 0 && sel.c2 > sel.c1 ? (sel.c2 - sel.c1 + 1) / wid : 1;
      const srcSheet = h.get().sheets.findIndex((s) => s.id === internal.sheetId);
      commitSheet((s) => {
        if (cut && srcSheet === si) {
          for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) delete s.cells[key(r, c)];
        }
        for (let ir = 0; ir < repR; ir++)
          for (let ic = 0; ic < repC; ic++)
            for (let r = 0; r < hgt; r++)
              for (let c = 0; c < wid; c++) {
                const tr = sel.r1 + ir * hgt + r,
                  tc = sel.c1 + ic * wid + c;
                const src = cells[key(r, c)];
                const k = key(tr, tc);
                if (!src) delete s.cells[k];
                else s.cells[k] = src.f !== undefined && !cut ? { ...src, f: shiftFormula(src.f, tr - (range.r1 + r), tc - (range.c1 + c)) } : { ...src };
              }
      });
      if (cut) {
        if (srcSheet !== si && srcSheet >= 0)
          commitSheet((s) => {
            for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) delete s.cells[key(r, c)];
          }, srcSheet);
        clip.current = null;
      }
      setCur({ r: sel.r1 + hgt * repR - 1, c: sel.c1 + wid * repC - 1 });
      setAnchor({ r: sel.r1, c: sel.c1 });
      return;
    }
    let grid: string[][];
    if (html && /<table/i.test(html)) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      grid = Array.from(doc.querySelectorAll('tr')).map((tr) => Array.from(tr.querySelectorAll('td,th')).map((td) => (td.textContent || '').trim()));
    } else grid = parseCsv(text.replace(/\r?\n$/, ''), text.includes('\t') ? '\t' : '\t');
    if (!grid.length) return;
    commitSheet((s) => {
      grid.forEach((row, r) =>
        row.forEach((raw, c) => {
          const k = key(sel.r1 + r, sel.c1 + c);
          const prev = s.cells[k];
          const { cell, fmt } = parseInput(raw, prev?.s);
          const style = fmt ? { ...(prev?.s || {}), ...fmt } : prev?.s;
          if (cell.v === undefined && cell.f === undefined && !style) delete s.cells[k];
          else s.cells[k] = { ...cell, ...(style ? { s: style } : {}) };
        })
      );
    });
    setAnchor({ r: sel.r1, c: sel.c1 });
    setCur({ r: sel.r1 + grid.length - 1, c: sel.c1 + Math.max(...grid.map((r) => r.length)) - 1 });
  };

  useEffect(() => {
    if (!active) return;
    const inGrid = () => document.activeElement === bodyRef.current;
    const onCopy = (e: ClipboardEvent) => {
      if (!inGrid()) return;
      e.preventDefault();
      e.clipboardData!.setData('text/plain', copy(false));
    };
    const onCut = (e: ClipboardEvent) => {
      if (!inGrid()) return;
      e.preventDefault();
      e.clipboardData!.setData('text/plain', copy(true));
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!inGrid()) return;
      e.preventDefault();
      paste(e.clipboardData!.getData('text/plain'), e.clipboardData!.getData('text/html'));
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  });

  // ---------- Structure ----------
  const insertAxis = (axis: 'row' | 'col', at: number, count: number) => {
    const w = h.get();
    const target = w.sheets[si];
    const sheets = w.sheets.map((s, idx) => {
      const cells: Record<string, Cell> = {};
      for (const k in s.cells) {
        let cell = s.cells[k];
        if (cell.f !== undefined) cell = { ...cell, f: adjustForInsert(cell.f, target.name, s.name, axis, at, count) };
        if (idx !== si) {
          cells[k] = cell;
          continue;
        }
        const { r, c } = parseKey(k);
        const v = axis === 'row' ? r : c;
        if (count < 0 && v >= at && v < at - count) continue;
        const nv = v >= at ? v + count : v;
        cells[axis === 'row' ? key(nv, c) : key(r, nv)] = cell;
      }
      if (idx !== si) return { ...s, cells };
      const shiftMap = (m: Record<number, number>) => {
        const out: Record<number, number> = {};
        for (const k in m) {
          const v = +k;
          if (count < 0 && v >= at && v < at - count) continue;
          out[v >= at ? v + count : v] = m[k];
        }
        return out;
      };
      return {
        ...s,
        cells,
        colW: axis === 'col' ? shiftMap(s.colW) : s.colW,
        rowH: axis === 'row' ? shiftMap(s.rowH) : s.rowH,
        merges: s.merges?.filter((m) => (axis === 'row' ? !(count < 0 && m.r1 >= at && m.r2 < at - count) : !(count < 0 && m.c1 >= at && m.c2 < at - count))).map((m) => {
          const f = (v: number) => (v >= at ? Math.max(at, v + count) : v);
          return axis === 'row' ? { ...m, r1: f(m.r1), r2: f(m.r2) } : { ...m, c1: f(m.c1), c2: f(m.c2) };
        })
      };
    });
    h.commit({ sheets });
    markDirty();
  };

  const sortRange = (desc: boolean) => {
    let g = sel;
    if (g.r1 === g.r2) {
      // Single row/cell selected: sort the whole data block below row 1 by this column.
      g = { r1: used.rows > 1 && hasHeaderRow() ? 1 : 0, r2: used.rows - 1, c1: 0, c2: used.cols - 1 };
    }
    g = { ...g, r2: Math.min(g.r2, used.rows - 1), c2: Math.min(g.c2, used.cols - 1) };
    const byCol = cur.c;
    const rowsData: { r: number; cells: (Cell | undefined)[]; keyV: any }[] = [];
    for (let r = g.r1; r <= g.r2; r++) {
      const cells: (Cell | undefined)[] = [];
      for (let c = g.c1; c <= g.c2; c++) cells.push(sheet.cells[key(r, c)]);
      rowsData.push({ r, cells, keyV: calc.value(sheet, r, byCol) });
    }
    rowsData.sort((a, b) => {
      const ae = a.keyV === null || a.keyV === '',
        be = b.keyV === null || b.keyV === '';
      if (ae !== be) return ae ? 1 : -1; // blanks last
      const c = compare(a.keyV, b.keyV);
      return desc ? -c : c;
    });
    commitSheet((s) => {
      rowsData.forEach((row, i) => {
        const tr = g.r1 + i;
        row.cells.forEach((cell, j) => {
          const k = key(tr, g.c1 + j);
          if (!cell) delete s.cells[k];
          else s.cells[k] = cell.f !== undefined ? { ...cell, f: shiftFormula(cell.f, tr - row.r, 0) } : cell;
        });
      });
    });
  };
  const hasHeaderRow = () => {
    for (let c = 0; c < used.cols; c++) {
      const v = sheet.cells[key(0, c)]?.v;
      if (typeof v === 'number') return false;
    }
    return true;
  };

  const toggleMerge = () => {
    const existing = (sheet.merges || []).find((m) => inRange(cur.r, cur.c, m));
    if (existing) {
      commitSheet((s) => void (s.merges = (s.merges || []).filter((m) => m !== existing)));
      return;
    }
    if (sel.r1 === sel.r2 && sel.c1 === sel.c2) return;
    commitSheet((s) => {
      s.merges = [...(s.merges || []).filter((m) => !(m.r1 <= sel.r2 && m.r2 >= sel.r1 && m.c1 <= sel.c2 && m.c2 >= sel.c1)), { ...sel }];
      const style = s.cells[key(sel.r1, sel.c1)]?.s;
      s.cells[key(sel.r1, sel.c1)] = { ...(s.cells[key(sel.r1, sel.c1)] || {}), s: { ...(style || {}), align: style?.align || 'center' } };
    });
  };

  // ---------- Sheets ----------
  const addSheet = () => {
    const w = h.get();
    let n = w.sheets.length + 1;
    while (w.sheets.some((s) => s.name.toLowerCase() === `sheet${n}`)) n++;
    h.commit({ sheets: [...w.sheets, newSheet(`Sheet${n}`)] });
    setSi(w.sheets.length);
    markDirty();
  };
  const renameSheet = (idx: number, name: string) => {
    const w = h.get();
    const old = w.sheets[idx].name;
    name = name.trim().replace(/[\\/?*[\]:]/g, '').slice(0, 31);
    if (!name || name === old) return;
    if (w.sheets.some((s, i) => i !== idx && s.name.toLowerCase() === name.toLowerCase())) {
      toast('Another sheet already has that name', 'error');
      return;
    }
    const sheets = w.sheets.map((s, i) => {
      const cells: Record<string, Cell> = {};
      for (const k in s.cells) {
        const c = s.cells[k];
        cells[k] = c.f !== undefined ? { ...c, f: renameSheetRefs(c.f, old, name) } : c;
      }
      return { ...s, cells, name: i === idx ? name : s.name };
    });
    h.commit({ sheets });
    markDirty();
  };
  const deleteSheet = async (idx: number) => {
    const w = h.get();
    if (w.sheets.length === 1) return toast('A workbook needs at least one sheet', 'error');
    const ok = await ask(`Delete "${w.sheets[idx].name}"?`, 'This sheet and everything on it will be removed.', [
      { id: 'cancel', label: 'Cancel' },
      { id: 'delete', label: 'Delete', danger: true, primary: true }
    ]);
    if (ok !== 'delete') return;
    h.commit({ sheets: w.sheets.filter((_, i) => i !== idx) });
    setSi((s) => Math.max(0, Math.min(s, w.sheets.length - 2)));
    markDirty();
  };
  const duplicateSheet = (idx: number) => {
    const w = h.get();
    const src = w.sheets[idx];
    let name = `${src.name} (2)`;
    let n = 2;
    while (w.sheets.some((s) => s.name === name)) name = `${src.name} (${++n})`;
    const copy: Sheet = { ...src, id: Math.random().toString(36).slice(2), name, cells: { ...src.cells } };
    const sheets = [...w.sheets];
    sheets.splice(idx + 1, 0, copy);
    h.commit({ sheets });
    setSi(idx + 1);
    markDirty();
  };

  useEffect(() => {
    setCur({ r: 0, c: 0 });
    setAnchor({ r: 0, c: 0 });
    setEditing(null);
    if (bodyRef.current) {
      bodyRef.current.scrollTop = 0;
      bodyRef.current.scrollLeft = 0;
    }
  }, [si]);

  // ---------- Save ----------
  const formats = (): SaveFormat[] => {
    const xlsx: SaveFormat = { name: 'Excel workbook', ext: 'xlsx', build: () => writeXlsx(h.get()) };
    const csv: SaveFormat = { name: 'CSV (current sheet)', ext: 'csv', build: async () => writeCsv(h.get(), si) };
    const tsv: SaveFormat = { name: 'Tab-separated (current sheet)', ext: 'tsv', build: async () => writeCsv(h.get(), si, '\t') };
    const ods: SaveFormat = { name: 'OpenDocument spreadsheet', ext: 'ods', build: async () => writeOds(h.get()) };
    const ext = tab.path ? extOf(tab.path) : '';
    if (ext === 'csv') return [csv, xlsx, tsv, ods];
    if (ext === 'tsv') return [tsv, xlsx, csv, ods];
    if (ext === 'ods') return [ods, xlsx, csv];
    return [xlsx, csv, tsv, ods];
  };
  const save = async (saveAs: boolean) => {
    if (editing && isSilentSave()) return false;
    if (editing) commitEdit();
    const ext = tab.path ? extOf(tab.path) : '';
    if (!saveAs && (ext === 'csv' || ext === 'tsv') && (h.get().sheets.length > 1 || Object.values(sheet.cells).some((c) => c.s || c.f))) {
      if (isSilentSave()) return false;
      const choice = await ask(
        'Save as CSV?',
        'CSV files only keep the values of the current sheet. Formatting, formulas and other sheets will be lost. Save as an Excel workbook to keep everything.',
        [
          { id: 'cancel', label: 'Cancel' },
          { id: 'csv', label: 'Keep CSV' },
          { id: 'xlsx', label: 'Save as Excel', primary: true }
        ]
      );
      if (choice === 'cancel') return false;
      if (choice === 'xlsx') return saveTabFile(tab.id, formats().filter((f) => f.ext === 'xlsx'), true);
    }
    return saveTabFile(tab.id, formats(), saveAs);
  };

  const printHtml = () => {
    const { rows: ur, cols: uc } = usedRange(sheet);
    let html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{margin:0.5in}body{font:10pt Arial,sans-serif;margin:0}table{border-collapse:collapse}td{border:1px solid #ccc;padding:2px 6px;white-space:nowrap;vertical-align:bottom}</style></head><body><table>`;
    for (let r = 0; r < ur; r++) {
      html += '<tr>';
      for (let c = 0; c < uc; c++) {
        const cell = sheet.cells[key(r, c)];
        const v = calc.value(sheet, r, c);
        const s = cell?.s || {};
        const align = s.align || (typeof v === 'number' ? 'right' : 'left');
        const css = [`text-align:${align}`, s.b ? 'font-weight:bold' : '', s.i ? 'font-style:italic' : '', s.color ? `color:${s.color}` : '', s.bg ? `background:${s.bg}` : '', `width:${(sheet.colW[c] ?? DEFAULT_COL_W) - 12}px`].filter(Boolean).join(';');
        html += `<td style="${css}">${escapeHtml(formatValue(v, s))}</td>`;
      }
      html += '</tr>';
    }
    return html + '</table></body></html>';
  };
  const print = async () => {
    await api.printHtml(printHtml());
  };
  const exportPdf = () => exportFile(`${baseName(tab.name)}.pdf`, { name: 'PDF', ext: 'pdf', build: () => api.pdfFromHtml(printHtml()) });

  const aiRef = useRef<AiHooks>(null as any);
  // The Claude Assistant's cell tools: which sheet (by name, else the one shown), and a range like "B2:D10".
  const sheetIndex = (name?: string) => {
    if (!name) return si;
    const i = h.get().sheets.findIndex((x) => x.name.toLowerCase() === String(name).toLowerCase());
    if (i < 0) throw new Error(`There's no sheet called “${name}”. Sheets: ${h.get().sheets.map((x) => x.name).join(', ')}.`);
    return i;
  };
  const range = (a: string) => {
    const [p, q] = String(a).split(':');
    const s1 = parseAddr(p.trim());
    const s2 = q ? parseAddr(q.trim()) : s1;
    if (!s1 || !s2) throw new Error(`“${a}” isn't a cell or range like B2 or A1:D10.`);
    return { r1: Math.min(s1.r, s2.r), c1: Math.min(s1.c, s2.c), r2: Math.max(s1.r, s2.r), c2: Math.max(s1.c, s2.c) };
  };
  aiRef.current = {
    noun: 'spreadsheet',
    insertLabel: 'Put in cells',
    tools: [
      {
        name: 'set_cells',
        description: 'Write values or formulas into cells, starting at the top-left cell `start` and filling right and down from the rows given. Each entry is what a person would type: a number, text, a date, or a formula starting with = (e.g. "=SUM(B2:B9)"). An empty string clears a cell. All of it is one undo step.',
        input_schema: {
          type: 'object',
          properties: {
            start: { type: 'string', description: 'Top-left cell, e.g. "A1"' },
            rows: { type: 'array', description: 'Rows of cell entries, e.g. [["Name","Score"],["Ana","91"]]', items: { type: 'array', items: { type: 'string' } } },
            sheet: { type: 'string', description: 'Sheet name (default: the sheet shown)' }
          },
          required: ['start', 'rows']
        },
        run: ({ start, rows, sheet: name }) => {
          const at = parseAddr(String(start).trim());
          if (!at) throw new Error(`“${start}” isn't a cell like A1.`);
          const idx = sheetIndex(name);
          let n = 0;
          commitSheet((sh) => {
            rows.forEach((row: unknown[], i: number) =>
              (Array.isArray(row) ? row : [row]).forEach((v, j) => {
                const k = key(at.r + i, at.c + j);
                const prev = sh.cells[k];
                const { cell, fmt } = parseInput(v == null ? '' : String(v), prev?.s);
                const style = fmt ? { ...(prev?.s || {}), ...fmt } : prev?.s;
                const next: Cell = { ...cell, ...(style ? { s: style } : {}) };
                if (next.v === undefined && next.f === undefined && !next.s) delete sh.cells[k];
                else sh.cells[k] = next;
                n++;
              })
            );
          }, idx);
          if (idx !== si) setSi(idx);
          return `Wrote ${n} cell${n === 1 ? '' : 's'} from ${addr(at.r, at.c)}.`;
        }
      },
      {
        name: 'read_range',
        description: 'Read cells as a grid, with each cell’s shown value and, for formulas, the formula itself ("value  ⟨=formula⟩").',
        input_schema: { type: 'object', properties: { range: { type: 'string', description: 'e.g. "A1:F30"' }, sheet: { type: 'string' } }, required: ['range'] },
        run: ({ range: a, sheet: name }) => {
          const w = h.get();
          const sh = w.sheets[sheetIndex(name)];
          const c = new Calc(w);
          const g = range(a);
          const lines: string[] = [];
          for (let r = g.r1; r <= Math.min(g.r2, g.r1 + 499); r++) {
            const row: string[] = [];
            for (let col = g.c1; col <= Math.min(g.c2, g.c1 + 59); col++) {
              const cell = sh.cells[key(r, col)];
              const v = formatValue(c.value(sh, r, col), cell?.s);
              row.push(cell?.f !== undefined ? `${v} ⟨${editText(cell)}⟩` : v);
            }
            lines.push(`${r + 1}\t${row.join('\t')}`);
          }
          return `\t${Array.from({ length: Math.min(g.c2, g.c1 + 59) - g.c1 + 1 }, (_, i) => colName(g.c1 + i)).join('\t')}\n${lines.join('\n')}`;
        }
      },
      {
        name: 'select_range',
        description: 'Select a cell or range so the student sees it (and so insert_text writes there).',
        input_schema: { type: 'object', properties: { range: { type: 'string' }, sheet: { type: 'string' } }, required: ['range'] },
        run: ({ range: a, sheet: name }) => {
          const idx = sheetIndex(name);
          if (idx !== si) setSi(idx);
          const g = range(a);
          setAnchor({ r: g.r1, c: g.c1 });
          setCur({ r: g.r2, c: g.c2 });
          scrollIntoView({ r: g.r1, c: g.c1 });
          return `Selected ${a}.`;
        }
      }
    ],
    async getDocument() {
      const w = h.get();
      const c = new Calc(w);
      const sections = w.sheets.map((s) => {
        const u = usedRange(s);
        const lines: string[] = [];
        for (let r = 0; r < Math.min(u.rows, 2000); r++) {
          const row: string[] = [];
          for (let col = 0; col < Math.min(u.cols, 60); col++) row.push(formatValue(c.value(s, r, col), s.cells[key(r, col)]?.s));
          lines.push(row.join('\t').replace(/\t+$/, ''));
        }
        return { id: s.id, label: `Sheet ${s.name}`, text: `Sheet "${s.name}"\n` + lines.join('\n') };
      });
      return { full: sections.map((x) => x.text).join('\n\n'), sections };
    },
    insertText(text) {
      const plain = text.replace(/\*\*/g, '').replace(/^\s*[-*•]\s+/gm, '').trim();
      // A formula reply goes into the active cell; tables/lists fill downwards.
      const formula = plain.match(/^=\S.*$/m);
      if (formula && plain.split('\n').length <= 3) {
        setInput(cur.r, cur.c, formula[0].trim());
        return true;
      }
      paste(plain);
      return true;
    },
    replaceSelection(text) {
      return aiRef.current.insertText!(text);
    },
    reveal(quote) {
      const q = quote.replace(/[“”"]/g, '').trim().toLowerCase().slice(0, 40);
      if (!q) return false;
      for (const k in sheet.cells) {
        const { r, c } = parseKey(k);
        if (formatValue(calc.value(sheet, r, c), sheet.cells[k].s).toLowerCase().includes(q)) {
          select({ r, c });
          bodyRef.current?.focus();
          return true;
        }
      }
      return false;
    }
  };
  const handlers = useRef({ save, print });
  handlers.current = { save, print };
  useEffect(() => {
    editorRegistry.set(tab.id, { save: (a) => handlers.current.save(a), print: () => handlers.current.print(), debugBuild: () => writeXlsx(h.get()), ai: proxyAi(aiRef) });
  }, [tab.id]);

  // Report the selected cells (as tab-separated text) to the AI sidebar.
  useEffect(() => {
    const t = setTimeout(() => {
      const g = { ...sel, r2: Math.min(sel.r2, Math.max(used.rows - 1, sel.r1), sel.r1 + 500), c2: Math.min(sel.c2, Math.max(used.cols - 1, sel.c1), sel.c1 + 50) };
      const text = rangeTsv(g);
      if (text.replace(/\s/g, '')) publishSelection(tab.id, (g.r1 === g.r2 && g.c1 === g.c2 ? '' : `Cells ${addr(g.r1, g.c1)}:${addr(g.r2, g.c2)}\n`) + text);
    }, 150);
    return () => clearTimeout(t);
  }, [sel.r1, sel.r2, sel.c1, sel.c2, si]);

  // ---------- Keyboard ----------
  const onGridKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    const mod = modKey(e);
    const k = e.key;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      const from = e.shiftKey ? cur : cur;
      const to = mod ? jump(from, dr, dc) : { r: from.r + dr, c: from.c + dc };
      select(to, e.shiftKey);
    };
    if (k === 'ArrowDown') return move(1, 0);
    if (k === 'ArrowUp') return move(-1, 0);
    if (k === 'ArrowRight') return move(0, 1);
    if (k === 'ArrowLeft') return move(0, -1);
    if (k === 'Tab') return move(0, e.shiftKey ? -1 : 1);
    if (k === 'Enter') {
      e.preventDefault();
      if (e.altKey || mod) return startEdit();
      const st = enterStep(e.shiftKey);
      return select({ r: cur.r + st.dr, c: cur.c + st.dc });
    }
    if (k === 'PageDown' || k === 'PageUp') {
      e.preventDefault();
      const pageRows = Math.max(1, Math.floor((bodyRef.current!.clientHeight - HEADER_H) / DEFAULT_ROW_H) - 1);
      return select({ r: cur.r + (k === 'PageDown' ? pageRows : -pageRows), c: cur.c }, e.shiftKey);
    }
    if (k === 'Home') {
      e.preventDefault();
      return select(mod ? { r: 0, c: 0 } : { r: cur.r, c: 0 }, e.shiftKey);
    }
    if (k === 'End' && mod) {
      e.preventDefault();
      return select({ r: Math.max(0, used.rows - 1), c: Math.max(0, used.cols - 1) }, e.shiftKey);
    }
    if (k === 'F2') {
      e.preventDefault();
      return startEdit();
    }
    if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      return clearRange();
    }
    if (k === 'Escape') {
      clip.current = null;
      return setAnchor(cur);
    }
    if (mod) {
      const kk = k.toLowerCase();
      if (kk === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (h.undo()) markDirty();
      } else if (kk === 'y' || (kk === 'z' && e.shiftKey)) {
        e.preventDefault();
        if (h.redo()) markDirty();
      } else if (kk === 'b') {
        e.preventDefault();
        applyStyle({ b: !activeStyle.b });
      } else if (kk === 'i') {
        e.preventDefault();
        applyStyle({ i: !activeStyle.i });
      } else if (kk === 'u') {
        e.preventDefault();
        applyStyle({ u: !activeStyle.u });
      } else if (kk === 'a') {
        e.preventDefault();
        setAnchor({ r: 0, c: 0 });
        setCur({ r: rows - 1, c: cols - 1 });
      } else if (kk === 'f') {
        e.preventDefault();
        setFindOpen(true);
      } else if (kk === ';') {
        e.preventDefault();
        setInput(cur.r, cur.c, new Date().toLocaleDateString('en-US'));
      } else if (kk === 'd') {
        e.preventDefault();
        if (sel.r2 > sel.r1) doFill({ ...sel, r2: sel.r1 }, sel);
      }
      return;
    }
    if (k.length === 1 && !e.altKey) {
      e.preventDefault();
      startEdit(k);
    }
  };

  const onEditorKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!editing) return;
    if (suggestions.length && (e.key === 'Tab' || (e.key === 'Enter' && suggestIdx >= 0 && editing.text.match(/[A-Za-z]$/)))) {
      e.preventDefault();
      acceptSuggestion(suggestions[Math.min(suggestIdx, suggestions.length - 1)]);
      return;
    }
    if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setSuggestIdx((i) => clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, suggestions.length - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit(enterStep(e.shiftKey));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commitEdit({ dr: 0, dc: e.shiftKey ? -1 : 1 });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (editing.mode === 'enter' && !editing.bar && e.key.startsWith('Arrow') && !formulaPicking()) {
      e.preventDefault();
      const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key]!;
      commitEdit({ dr: d[0], dc: d[1] });
    }
    e.stopPropagation();
  };

  useEffect(() => {
    if (active && !editing) setTimeout(() => bodyRef.current?.focus(), 0);
  }, [active]);

  // ---------- Status ----------
  const stats = useMemo(() => {
    if (sel.r1 === sel.r2 && sel.c1 === sel.c2) return null;
    let sum = 0,
      count = 0,
      nums = 0;
    const r2 = Math.min(sel.r2, used.rows - 1),
      c2 = Math.min(sel.c2, used.cols - 1);
    for (let r = sel.r1; r <= r2; r++)
      for (let c = sel.c1; c <= c2; c++) {
        const v = calc.value(sheet, r, c);
        if (v === null || v === '') continue;
        count++;
        if (typeof v === 'number') {
          sum += v;
          nums++;
        }
      }
    return { sum, count, avg: nums ? sum / nums : 0, nums };
  }, [sel.r1, sel.r2, sel.c1, sel.c2, calc, sheet]);

  // Highlight references of the formula being edited.
  const editRefs = useMemo(() => (editing && editing.text.startsWith('=') ? formulaRefs(editing.text.slice(1)).filter((r) => !r.sheet || r.sheet.toLowerCase() === sheet.name.toLowerCase()) : []), [editing?.text, sheet.name]);

  // ---------- Render ----------
  const rowsToRender: number[] = [];
  for (let r = 0; r < fz.rows; r++) rowsToRender.push(r);
  for (let r = view.r0; r <= view.r1; r++) if (!sheet.hiddenRows?.[r]) rowsToRender.push(r);
  const colsToRender: number[] = [];
  for (let c = 0; c < fz.cols; c++) colsToRender.push(c);
  for (let c = view.c0; c <= view.c1; c++) colsToRender.push(c);

  const boxFor = (g: Range) => {
    const left = HEADER_W + geo.colStart[g.c1];
    const top = HEADER_H + geo.rowStart[g.r1];
    const width = geo.colStart[Math.min(g.c2 + 1, cols)] - geo.colStart[g.c1];
    const height = geo.rowStart[Math.min(g.r2 + 1, rows)] - geo.rowStart[g.r1];
    const fr = g.r2 < fz.rows,
      fc = g.c2 < fz.cols;
    return { left, top, width, height, cls: `${fr ? 'fr' : ''} ${fc ? 'fc' : ''}` };
  };
  // ---------- Borders, charts, filters, validation, summaries ----------
  const applyBorders = (kind: 'all' | 'outer' | 'inner' | 'top' | 'bottom' | 'left' | 'right' | 'none', b: Border) => {
    const g = { ...sel, r2: Math.min(sel.r2, rows - 1), c2: Math.min(sel.c2, cols - 1) };
    if ((g.r2 - g.r1 + 1) * (g.c2 - g.c1 + 1) > 200000) return toast('Select a smaller range for borders.');
    commitSheet((s) => {
      for (let r = g.r1; r <= g.r2; r++)
        for (let c = g.c1; c <= g.c2; c++) {
          const k = key(r, c);
          const st: CellStyle = { ...(s.cells[k]?.s || {}) };
          const set = (side: 'bt' | 'bb' | 'bl' | 'br', on: boolean) => {
            if (on) st[side] = b;
          };
          if (kind === 'none') delete st.bt, delete st.bb, delete st.bl, delete st.br;
          set('bt', kind === 'all' || kind === 'top' ? r === g.r1 || kind === 'all' : (kind === 'outer' && r === g.r1) || (kind === 'inner' && r > g.r1));
          set('bb', kind === 'all' || (kind === 'bottom' && r === g.r2) || (kind === 'outer' && r === g.r2) || (kind === 'inner' && r < g.r2));
          set('bl', kind === 'all' || (kind === 'left' && c === g.c1) || (kind === 'outer' && c === g.c1) || (kind === 'inner' && c > g.c1));
          set('br', kind === 'all' || (kind === 'right' && c === g.c2) || (kind === 'outer' && c === g.c2) || (kind === 'inner' && c < g.c2));
          if (kind === 'top' && r !== g.r1) delete st.bt;
          s.cells[k] = { ...(s.cells[k] || {}), s: st };
        }
    });
  };

  const dataRange = () => (sel.r1 !== sel.r2 || sel.c1 !== sel.c2 ? { ...sel, r2: Math.min(sel.r2, used.rows - 1), c2: Math.min(sel.c2, used.cols - 1) } : currentRegion(sheet, cur.r, cur.c));
  const newChart = () => {
    const range = dataRange();
    const x = geo.colStart[Math.min(range.c2 + 1, cols - 1)] + 24;
    const y = geo.rowStart[range.r1];
    setChartEdit({ chart: { id: uid(), type: 'column', range, x, y, w: 480, h: 300, headerRow: true, labelCol: true }, isNew: true });
  };
  const saveChart = (c: Chart) =>
    commitSheet((s) => {
      const list = s.charts || [];
      s.charts = list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...list, c];
    });
  const removeChart = (id: string) => commitSheet((s) => void (s.charts = (s.charts || []).filter((x) => x.id !== id)));

  const toggleFilter = () => {
    if (sheet.filter) {
      commitSheet((s) => {
        s.filter = null;
        s.hiddenRows = undefined;
      });
      return;
    }
    const range = dataRange();
    if (range.r2 <= range.r1) return toast('Select a table with a header row to filter.');
    commitSheet((s) => {
      s.filter = { range, cols: {} };
    });
  };
  const setFilterCol = (col: number, crit: FilterState['cols'][number] | null) =>
    commitSheet((s) => {
      const f: FilterState = { ...s.filter!, cols: { ...s.filter!.cols } };
      if (crit) f.cols[col] = crit;
      else delete f.cols[col];
      s.filter = f;
      s.hiddenRows = filteredRows(s, calc, f);
    });
  const sortFilter = (col: number, desc: boolean) => {
    const f = sheet.filter!;
    const g = { ...f.range, r1: f.range.r1 + 1 };
    const rowsData: { r: number; cells: (Cell | undefined)[]; keyV: any }[] = [];
    for (let r = g.r1; r <= g.r2; r++) {
      const cells: (Cell | undefined)[] = [];
      for (let c = g.c1; c <= g.c2; c++) cells.push(sheet.cells[key(r, c)]);
      rowsData.push({ r, cells, keyV: calc.value(sheet, r, col) });
    }
    rowsData.sort((a, b) => {
      const ae = a.keyV === null || a.keyV === '',
        be = b.keyV === null || b.keyV === '';
      if (ae !== be) return ae ? 1 : -1;
      const c = compare(a.keyV, b.keyV);
      return desc ? -c : c;
    });
    commitSheet((s) => {
      rowsData.forEach((row, i) => {
        const tr = g.r1 + i;
        row.cells.forEach((cell, j) => {
          const k = key(tr, g.c1 + j);
          if (!cell) delete s.cells[k];
          else s.cells[k] = cell.f !== undefined ? { ...cell, f: shiftFormula(cell.f, tr - row.r, 0) } : cell;
        });
      });
    });
  };

  const removeDuplicates = () => {
    const g = dataRange();
    const header = hasHeaderRow() && g.r1 === 0 ? 1 : 0;
    const seen = new Set<string>();
    const keep: (Cell | undefined)[][] = [];
    let removed = 0;
    for (let r = g.r1 + header; r <= g.r2; r++) {
      const row: (Cell | undefined)[] = [];
      const sig: string[] = [];
      for (let c = g.c1; c <= g.c2; c++) {
        row.push(sheet.cells[key(r, c)]);
        sig.push(formatValue(calc.value(sheet, r, c)).toLowerCase());
      }
      const k = sig.join('\u0001');
      if (seen.has(k)) removed++;
      else {
        seen.add(k);
        keep.push(row);
      }
    }
    if (!removed) return toast('No duplicate rows found.');
    commitSheet((s) => {
      for (let r = g.r1 + header; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) delete s.cells[key(r, c)];
      keep.forEach((row, i) => row.forEach((cell, j) => cell && (s.cells[key(g.r1 + header + i, g.c1 + j)] = cell)));
    });
    toast(`Removed ${removed} duplicate row${removed > 1 ? 's' : ''}`, 'success');
  };

  const pivotSource = () => {
    const g = dataRange();
    const headers: string[] = [];
    for (let c = g.c1; c <= g.c2; c++) headers.push(formatValue(calc.value(sheet, g.r1, c)));
    return { g, headers };
  };
  const createPivot = (o: { group: number; group2: number | null; value: number | null; agg: 'sum' | 'count' | 'average' | 'min' | 'max' }) => {
    const { g, headers } = pivotSource();
    const rowKeys: string[] = [];
    const colKeys: string[] = [];
    const cellsAgg = new Map<string, number[]>();
    for (let r = g.r1 + 1; r <= g.r2; r++) {
      const rk = formatValue(calc.value(sheet, r, g.c1 + o.group)) || '(blank)';
      const ck = o.group2 === null ? '' : formatValue(calc.value(sheet, r, g.c1 + o.group2)) || '(blank)';
      if (!rowKeys.includes(rk)) rowKeys.push(rk);
      if (!colKeys.includes(ck)) colKeys.push(ck);
      const v = o.value === null ? 1 : calc.value(sheet, r, g.c1 + o.value);
      const list = cellsAgg.get(rk + '\u0001' + ck) || [];
      if (o.agg === 'count') list.push(v === null || v === '' ? 0 : 1);
      else if (typeof v === 'number') list.push(v);
      cellsAgg.set(rk + '\u0001' + ck, list);
    }
    const aggOf = (l: number[] | undefined) => {
      if (!l || !l.length) return null;
      switch (o.agg) {
        case 'average':
          return l.reduce((a, b) => a + b, 0) / l.length;
        case 'min':
          return Math.min(...l);
        case 'max':
          return Math.max(...l);
        default:
          return l.reduce((a, b) => a + b, 0);
      }
    };
    rowKeys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    colKeys.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const out = newSheet(`Summary of ${headers[o.group] || 'data'}`.slice(0, 31));
    const label = `${o.agg[0].toUpperCase() + o.agg.slice(1)} of ${o.value === null ? 'rows' : headers[o.value]}`;
    out.cells[key(0, 0)] = { v: headers[o.group] || 'Group', s: { b: true, bg: '#e8f0fe' } };
    colKeys.forEach((ck, j) => (out.cells[key(0, j + 1)] = { v: o.group2 === null ? label : ck, s: { b: true, bg: '#e8f0fe', align: 'right' } }));
    out.cells[key(0, colKeys.length + 1)] = { v: 'Total', s: { b: true, bg: '#e8f0fe', align: 'right' } };
    rowKeys.forEach((rk, i) => {
      out.cells[key(i + 1, 0)] = { v: rk };
      let all: number[] = [];
      colKeys.forEach((ck, j) => {
        const l = cellsAgg.get(rk + '\u0001' + ck);
        const v = aggOf(l);
        if (v !== null) out.cells[key(i + 1, j + 1)] = { v };
        all = all.concat(l || []);
      });
      const t = aggOf(all);
      if (t !== null) out.cells[key(i + 1, colKeys.length + 1)] = { v: t, s: { b: true } };
    });
    out.colW[0] = 160;
    const w = h.get();
    h.commit({ sheets: [...w.sheets, out] });
    markDirty();
    setSi(w.sheets.length);
    toast('Summary created on a new sheet', 'success');
  };

  const activeValidation = validationAt(sheet, cur.r, cur.c);
  const selBox = boxFor(sel);
  const activeMerge = mergeAt.get(key(cur.r, cur.c));
  const curBox = boxFor(activeMerge || { r1: cur.r, c1: cur.c, r2: cur.r, c2: cur.c });
  const editCellW = editing ? geo.cw(editing.c) : 0;

  const barText = editing ? editing.text : editText(activeCell);
  const nameBox = sel.r1 === sel.r2 && sel.c1 === sel.c2 ? addr(cur.r, cur.c) : `${addr(sel.r1, sel.c1)}:${addr(Math.min(sel.r2, rows - 1), Math.min(sel.c2, cols - 1))}`;

  return (
    <div className={`sheet-editor ${!showGrid || sheet.gridlines === false ? 'no-grid' : ''}`} style={{ ['--grid-font' as any]: `${gridFont}px` }}>
      <SheetToolbar
        style={activeStyle}
        canUndo={h.canUndo()}
        canRedo={h.canRedo()}
        onUndo={() => h.undo() && markDirty()}
        onRedo={() => h.redo() && markDirty()}
        applyStyle={applyStyle}
        onSort={sortRange}
        onSum={() => {
          // AutoSum below a column selection, or in the active cell for the block above it.
          if (sel.r2 > sel.r1 && sel.c1 === sel.c2) {
            const target = { r: Math.min(sel.r2, used.rows - 1) + 1, c: sel.c1 };
            setInput(target.r, target.c, `=SUM(${addr(sel.r1, sel.c1)}:${addr(target.r - 1, sel.c1)})`);
            select(target);
          } else {
            let r = cur.r - 1;
            while (r >= 0 && typeof calc.value(sheet, r, cur.c) === 'number') r--;
            const from = r + 1;
            startEdit(from < cur.r ? `=SUM(${addr(from, cur.c)}:${addr(cur.r - 1, cur.c)})` : '=SUM(');
          }
        }}
        onMerge={toggleMerge}
        merged={!!activeMerge}
        freeze={fz}
        onFreeze={(f) => commitSheet((s) => void (s.freeze = f))}
        cur={cur}
        onFind={() => setFindOpen(true)}
        onSave={save}
        onPrint={print}
        onExportPdf={exportPdf}
        onExportCsv={() => exportFile(`${baseName(tab.name)} - ${sheet.name}.csv`, { name: 'CSV', ext: 'csv', build: async () => writeCsv(h.get(), si) })}
        onInsertFunction={(name) => startEdit(`=${name}(`)}
        onBorders={applyBorders}
        onChart={newChart}
        filterOn={!!sheet.filter}
        onFilter={toggleFilter}
        onValidation={() => setDlg('validation')}
        onCondFormat={() => setDlg('cf')}
        onDedupe={removeDuplicates}
        onPivot={() => setDlg('pivot')}
      />
      {chartEdit && (
        <ChartDialog
          chart={chartEdit.chart}
          sheet={sheet}
          calc={calc}
          onClose={() => setChartEdit(null)}
          onSave={(c) => (saveChart(c), setChartEdit(null), setSelChart(c.id))}
          onDelete={chartEdit.isNew ? undefined : () => (removeChart(chartEdit.chart.id), setChartEdit(null))}
        />
      )}
      {dlg === 'cf' && <CondFormatDialog rules={sheet.condRules || []} selection={dataRange()} onClose={() => setDlg(null)} onSave={(rules) => commitSheet((s) => void (s.condRules = rules))} />}
      {dlg === 'validation' && (
        <ValidationDialog
          existing={activeValidation}
          selection={sel}
          onClose={() => setDlg(null)}
          onRemove={activeValidation ? () => commitSheet((s) => void (s.validations = (s.validations || []).filter((v) => v.id !== activeValidation.id))) : undefined}
          onSave={(v) =>
            commitSheet((s) => {
              const list = s.validations || [];
              s.validations = list.some((x) => x.id === v.id) ? list.map((x) => (x.id === v.id ? v : x)) : [...list, v];
            })
          }
        />
      )}
      {dlg === 'pivot' && <PivotDialog headers={pivotSource().headers} onClose={() => setDlg(null)} onCreate={createPivot} />}
      {filterMenu && sheet.filter && (
        <div className="fm-scrim" onMouseDown={() => setFilterMenu(null)}>
          <div style={{ position: 'fixed', left: Math.min(filterMenu.x, window.innerWidth - 290), top: Math.min(filterMenu.y, window.innerHeight - 480) }} onMouseDown={(e) => e.stopPropagation()}>
            <FilterMenu sheet={sheet} calc={calc} filter={sheet.filter} col={filterMenu.col} onClose={() => setFilterMenu(null)} onApply={(crit) => setFilterCol(filterMenu.col, crit)} onSort={(desc) => sortFilter(filterMenu.col, desc)} />
          </div>
        </div>
      )}
      {dropdown && activeValidation?.type === 'list' && (
        <div className="fm-scrim" onMouseDown={() => setDropdown(null)}>
          <div className="dd-list" style={{ left: dropdown.x, top: dropdown.y }} onMouseDown={(e) => e.stopPropagation()}>
            {listItems(activeValidation, wb, calc, sheet).map((item) => (
              <button
                key={item}
                className="menu-item"
                onClick={() => {
                  setInput(dropdown.r, dropdown.c, item);
                  setDropdown(null);
                  bodyRef.current?.focus();
                }}
              >
                {item}
              </button>
            ))}
            {!listItems(activeValidation, wb, calc, sheet).length && <div className="muted" style={{ padding: 8 }}>No items</div>}
          </div>
        </div>
      )}

      <div className="formula-bar">
        <div className="name-box" title="Go to a cell (e.g. B12)">
          <input
            value={nameBox}
            onChange={() => {}}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const v = (e.target as HTMLInputElement).value.trim().toUpperCase();
              const [a, b] = v.split(':').map(parseAddr);
              if (a) {
                select(a);
                if (b) setCur(b);
                bodyRef.current?.focus();
              }
            }}
            onInput={(e) => {
              const el = e.target as HTMLInputElement;
              el.dataset.v = el.value;
            }}
          />
        </div>
        <span className="fx">fx</span>
        <input
          ref={barRef}
          className="bar-input"
          value={barText}
          spellCheck={false}
          onFocus={() => {
            if (!editing) startEdit(undefined, true);
            else if (!editing.bar) setEditing({ ...editing, bar: true });
          }}
          onChange={(e) => setEditing((ed) => (ed ? { ...ed, text: e.target.value, bar: true } : { r: cur.r, c: cur.c, text: e.target.value, mode: 'edit', bar: true }))}
          onKeyDown={onEditorKey}
        />
      </div>

      {findOpen && <FindBar sheet={sheet} calc={calc} onClose={() => (setFindOpen(false), bodyRef.current?.focus())} onGo={(p) => select(p)} onReplaceAll={(q, rep) => {
        let n = 0;
        commitSheet((s) => {
          for (const k in s.cells) {
            const c = s.cells[k];
            if (typeof c.v === 'string' && c.v.toLowerCase().includes(q.toLowerCase())) {
              s.cells[k] = { ...c, v: c.v.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), rep) };
              n++;
            }
          }
        });
        toast(n ? `Replaced in ${n} cell${n > 1 ? 's' : ''}` : 'Nothing to replace', n ? 'success' : 'info');
      }} />}

      <div
        className="sheet-body"
        ref={bodyRef}
        tabIndex={0}
        onScroll={updateView}
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClickHeader}
        onKeyDown={onGridKey}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, kind: 'cell' });
        }}
      >
        <div className="sheet-content" style={{ width: HEADER_W + geo.totalW, height: HEADER_H + geo.totalH }}>
          <CellsLayer sheet={sheet} calc={calc} geo={geo} rows={rowsToRender} cols={colsToRender} fz={fz} mergeAt={mergeAt} editingKey={editing ? key(editing.r, editing.c) : ''} cf={cf} checkboxAt={checkboxAt} />

          {/* Filter buttons in the header row */}
          {sheet.filter &&
            Array.from({ length: sheet.filter.range.c2 - sheet.filter.range.c1 + 1 }, (_, i) => sheet.filter!.range.c1 + i).map((c) => {
              const r = sheet.filter!.range.r1;
              const on = !!sheet.filter!.cols[c];
              return (
                <button
                  key={`flt${c}`}
                  className={`flt-btn ${on ? 'on' : ''} ${r < fz.rows ? 'fr' : ''} ${c < fz.cols ? 'fc' : ''}`}
                  style={{ left: HEADER_W + geo.colStart[c + 1] - 21, top: HEADER_H + geo.rowStart[r] + Math.max(0, (geo.rh(r) - 18) / 2) }}
                  title="Filter and sort"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setFilterMenu({ col: c, x: e.clientX - 10, y: e.clientY + 12 });
                  }}
                >
                  <FilterIcon size={11} />
                </button>
              );
            })}

          {/* Dropdown arrow in a list cell */}
          {!editing && activeValidation?.type === 'list' && (
            <button
              className={`dd-btn ${curBox.cls}`}
              style={{ left: curBox.left + curBox.width - 20, top: curBox.top + Math.max(0, (curBox.height - 18) / 2) }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setDropdown({ r: cur.r, c: cur.c, x: r.right - 200, y: r.bottom + 4 });
              }}
            >
              <Caret size={13} />
            </button>
          )}
          {!editing && activeValidation?.help && (
            <div className={`dv-help ${curBox.cls}`} style={{ left: curBox.left, top: curBox.top + curBox.height + 6 }}>
              {activeValidation.help}
            </div>
          )}

          {/* Charts float over the grid */}
          {(sheet.charts || []).map((ch) => (
            <ChartBox
              key={ch.id}
              chart={ch}
              sheet={sheet}
              calc={calc}
              selected={selChart === ch.id}
              onSelect={() => setSelChart(ch.id)}
              onEdit={() => setChartEdit({ chart: ch, isNew: false })}
              onChange={(c) => saveChart(c)}
              onDelete={() => removeChart(ch.id)}
            />
          ))}

          {editRefs.map((g, i) => {
            const b = boxFor(g);
            return <div key={i} className={`ref-box ${b.cls}`} style={{ left: b.left, top: b.top, width: b.width, height: b.height, borderColor: REF_COLORS[i % REF_COLORS.length], background: REF_COLORS[i % REF_COLORS.length] + '1a' }} />;
          })}

          {(sel.r1 !== sel.r2 || sel.c1 !== sel.c2) && <div className={`sel-range ${selBox.cls}`} style={{ left: selBox.left, top: selBox.top, width: selBox.width, height: selBox.height }} />}
          {clip.current && clip.current.sheetId === sheet.id && (() => {
            const b = boxFor(clip.current.range);
            return <div className={`clip-box ${b.cls}`} style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />;
          })()}
          {fillPreview && (() => {
            const b = boxFor(fillPreview);
            return <div className={`fill-box ${b.cls}`} style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />;
          })()}
          {!editing && <div className={`sel-active ${curBox.cls}`} style={{ left: curBox.left, top: curBox.top, width: curBox.width, height: curBox.height }} />}
          {!editing && sel.r2 < rows - 1 && sel.c2 < cols - 1 && (
            <div className={`fill-handle ${selBox.cls}`} data-fill="1" style={{ left: selBox.left + selBox.width - 4, top: selBox.top + selBox.height - 4 }} title="Drag to fill" />
          )}

          {/* Headers */}
          <div className="corner" />
          {colsToRender.map((c) => {
            const on = c >= sel.c1 && c <= sel.c2;
            const full = on && sel.r1 === 0 && sel.r2 >= rows - 1;
            return (
              <div key={`ch${c}`} className={`col-head ${c < fz.cols ? 'fc' : ''} ${on ? 'on' : ''} ${full ? 'full' : ''}`} style={{ left: HEADER_W + geo.colStart[c], width: geo.cw(c) }}>
                {colName(c)}
              </div>
            );
          })}
          {rowsToRender.map((r) => {
            const on = r >= sel.r1 && r <= sel.r2;
            const full = on && sel.c1 === 0 && sel.c2 >= cols - 1;
            return (
              <div key={`rh${r}`} className={`row-head ${r < fz.rows ? 'fr' : ''} ${on ? 'on' : ''} ${full ? 'full' : ''}`} style={{ top: HEADER_H + geo.rowStart[r], height: geo.rh(r) }}>
                {r + 1}
              </div>
            );
          })}
          {fz.rows > 0 && <div className="freeze-line h" style={{ top: HEADER_H + frozenH - 1, width: HEADER_W + geo.totalW }} />}
          {fz.cols > 0 && <div className="freeze-line v" style={{ left: HEADER_W + frozenW - 1, height: HEADER_H + geo.totalH }} />}
          <div className="resize-guide-x" />
          <div className="resize-guide-y" />

          {editing && !editing.bar && (() => {
            const b = boxFor(mergeAt.get(key(editing.r, editing.c)) || { r1: editing.r, c1: editing.c, r2: editing.r, c2: editing.c });
            const s = sheet.cells[key(editing.r, editing.c)]?.s;
            return (
              <div className={`cell-editor ${b.cls}`} style={{ left: b.left, top: b.top, minWidth: Math.max(editCellW, b.width), height: b.height }}>
                <input
                  ref={editorRef}
                  value={editing.text}
                  spellCheck={false}
                  style={{
                    width: Math.max(b.width, measure(editing.text) + 24),
                    fontWeight: s?.b ? 600 : undefined,
                    fontStyle: s?.i ? 'italic' : undefined,
                    textAlign: editing.text.startsWith('=') ? 'left' : s?.align
                  }}
                  onChange={(e) => {
                    setEditing({ ...editing, text: e.target.value });
                    setSuggestIdx(0);
                  }}
                  onKeyDown={onEditorKey}
                  onBlur={(e) => {
                    // Commit when focus leaves the grid entirely (e.g. clicking the toolbar).
                    const to = e.relatedTarget as HTMLElement | null;
                    if (!to || (!bodyRef.current?.contains(to) && to !== barRef.current)) commitEdit();
                  }}
                />
                {suggestions.length > 0 && (
                  <div className="suggest">
                    {suggestions.map((f, i) => (
                      <div key={f} className={`sg ${i === suggestIdx ? 'on' : ''}`} onMouseDown={(e) => (e.preventDefault(), acceptSuggestion(f))}>
                        <b>{f}</b>
                      </div>
                    ))}
                    <div className="sg-hint">Tab to insert</div>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      <div className="sheet-tabs">
        <button className="icon-btn sm" title="Add sheet" onClick={addSheet}>
          <Plus size={16} />
        </button>
        <div className="sheet-tab-list">
          {wb.sheets.map((s, i) =>
            renaming === i ? (
              <input
                key={s.id}
                className="sheet-tab-input"
                autoFocus
                defaultValue={s.name}
                onFocus={(e) => e.target.select()}
                onBlur={(e) => {
                  renameSheet(i, e.target.value);
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <button
                key={s.id}
                className={`sheet-tab ${i === si ? 'active' : ''}`}
                onClick={() => {
                  if (editing) commitEdit();
                  setSi(i);
                }}
                onDoubleClick={() => setRenaming(i)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, kind: 'tab', index: i });
                }}
              >
                {s.name}
              </button>
            )
          )}
        </div>
        <div className="grow" />
        {showStats && stats && (
          <div className="sheet-stats">
            {stats.nums > 0 && <span>Sum: {formatValue(stats.sum)}</span>}
            {stats.nums > 0 && <span>Average: {formatValue(Math.round(stats.avg * 1e6) / 1e6)}</span>}
            <span>Count: {stats.count}</span>
          </div>
        )}
      </div>

      {menu && (
        <>
          <div ref={setMenuAnchor} style={{ position: 'fixed', left: menu.x, top: menu.y, width: 1, height: 1 }} />
          <Popover anchor={menuAnchor} open={!!menuAnchor} onClose={() => (setMenu(null), setMenuAnchor(null))}>
            {(() => {
              const close = () => (setMenu(null), setMenuAnchor(null));
              if (menu.kind === 'tab') {
                const i = menu.index!;
                return (
                  <>
                    <button className="menu-item" onClick={() => (setRenaming(i), close())}>
                      <Pencil size={16} /> Rename
                    </button>
                    <button className="menu-item" onClick={() => (duplicateSheet(i), close())}>
                      <Copy size={16} /> Duplicate
                    </button>
                    <div className="menu-sep" />
                    <button className="menu-item" onClick={() => (deleteSheet(i), close())} style={{ color: 'var(--danger)' }}>
                      <Trash2 size={16} color="var(--danger)" /> Delete
                    </button>
                  </>
                );
              }
              const nRows = Math.min(sel.r2, rows - 1) - sel.r1 + 1;
              const nCols = Math.min(sel.c2, cols - 1) - sel.c1 + 1;
              const exec = (cmd: 'copy' | 'cut') => {
                bodyRef.current?.focus();
                document.execCommand(cmd);
              };
              return (
                <>
                  <button className="menu-item" onClick={() => (exec('cut'), close())}>
                    <Scissors size={16} /> Cut <span className="kbd">Ctrl+X</span>
                  </button>
                  <button className="menu-item" onClick={() => (exec('copy'), close())}>
                    <Copy size={16} /> Copy <span className="kbd">Ctrl+C</span>
                  </button>
                  <button
                    className="menu-item"
                    onClick={async () => {
                      close();
                      try {
                        paste(await navigator.clipboard.readText());
                      } catch {
                        toast('Use Ctrl+V to paste', 'info');
                      }
                    }}
                  >
                    <ClipboardPaste size={16} /> Paste <span className="kbd">Ctrl+V</span>
                  </button>
                  <div className="menu-sep" />
                  <button className="menu-item" onClick={() => (insertAxis('row', sel.r1, nRows > 1000 ? 1 : nRows), close())}>
                    <Rows3 size={16} /> Insert {nRows > 1 && nRows < 1000 ? `${nRows} rows` : 'row'} above
                  </button>
                  <button className="menu-item" onClick={() => (insertAxis('row', Math.min(sel.r2, rows - 1) + 1, nRows > 1000 ? 1 : nRows), close())}>
                    <Rows3 size={16} /> Insert {nRows > 1 && nRows < 1000 ? `${nRows} rows` : 'row'} below
                  </button>
                  <button className="menu-item" onClick={() => (insertAxis('col', sel.c1, nCols > 100 ? 1 : nCols), close())}>
                    <Columns3 size={16} /> Insert {nCols > 1 && nCols < 100 ? `${nCols} columns` : 'column'} left
                  </button>
                  <button className="menu-item" onClick={() => (insertAxis('col', Math.min(sel.c2, cols - 1) + 1, nCols > 100 ? 1 : nCols), close())}>
                    <Columns3 size={16} /> Insert {nCols > 1 && nCols < 100 ? `${nCols} columns` : 'column'} right
                  </button>
                  <div className="menu-sep" />
                  <button className="menu-item" onClick={() => (insertAxis('row', sel.r1, -nRows), close())}>
                    <Trash2 size={16} /> Delete {nRows > 1 ? `${nRows} rows` : 'row'}
                  </button>
                  <button className="menu-item" onClick={() => (insertAxis('col', sel.c1, -nCols), close())}>
                    <Trash2 size={16} /> Delete {nCols > 1 ? `${nCols} columns` : 'column'}
                  </button>
                  <button className="menu-item" onClick={() => (clearRange(sel, 'contents'), close())}>
                    <Eraser size={16} /> Clear contents <span className="kbd">Del</span>
                  </button>
                  <button className="menu-item" onClick={() => (clearRange(sel, 'all'), close())}>
                    <Eraser size={16} /> Clear formatting too
                  </button>
                  <div className="menu-sep" />
                  <button className="menu-item" onClick={() => (sortRange(false), close())}>
                    <ArrowDownAZ size={16} /> Sort A → Z
                  </button>
                  <button className="menu-item" onClick={() => (sortRange(true), close())}>
                    <ArrowUpAZ size={16} /> Sort Z → A
                  </button>
                  {sel.c1 === sel.c2 && (
                    <button className="menu-item" onClick={() => (autoFit(sel.c1), close())}>
                      <Columns3 size={16} /> Fit column to contents
                    </button>
                  )}
                </>
              );
            })()}
          </Popover>
        </>
      )}
    </div>
  );
}

const measureCtx = document.createElement('canvas').getContext('2d')!;
measureCtx.font = '13px Inter, Segoe UI, sans-serif';
const measure = (s: string) => measureCtx.measureText(s).width;

// ---------- Cells ----------
const BORDER_W: Record<string, number> = { thin: 1, medium: 2, thick: 3, dashed: 1, dotted: 1, double: 3 };
/** Cell borders drawn as inset shadows, so they never change the cell's size. */
function borderShadow(s?: CellStyle): string | undefined {
  if (!s || (!s.bt && !s.bb && !s.bl && !s.br)) return undefined;
  const out: string[] = [];
  const col = (b: Border) => b.color || '#000';
  if (s.bt) out.push(`inset 0 ${BORDER_W[s.bt.style] || 1}px 0 ${col(s.bt)}`);
  if (s.bb) out.push(`inset 0 -${BORDER_W[s.bb.style] || 1}px 0 ${col(s.bb)}`);
  if (s.bl) out.push(`inset ${BORDER_W[s.bl.style] || 1}px 0 0 ${col(s.bl)}`);
  if (s.br) out.push(`inset -${BORDER_W[s.br.style] || 1}px 0 0 ${col(s.br)}`);
  return out.join(', ');
}

/** A chart floating over the grid: drag to move, corner to resize, double-click to edit. */
function ChartBox({ chart, sheet, calc, selected, onSelect, onEdit, onChange, onDelete }: { chart: Chart; sheet: Sheet; calc: Calc; selected: boolean; onSelect(): void; onEdit(): void; onChange(c: Chart): void; onDelete(): void }) {
  const [live, setLive] = useState<Chart | null>(null);
  const c = live || chart;
  const svg = useMemo(() => chartSvg(c, chartData(c, sheet, calc), c.w, c.h, 'dark'), [c.type, c.range, c.title, c.w, c.h, c.legend, c.stacked, c.smooth, c.showValues, c.headerRow, c.labelCol, c.seriesBy, c.xTitle, c.yTitle, sheet, calc]);
  const start = (e: React.MouseEvent, mode: 'move' | 'resize') => {
    e.preventDefault();
    e.stopPropagation();
    onSelect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const base = { ...chart };
    let latest = base;
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      latest = mode === 'move' ? { ...base, x: Math.max(0, base.x + dx), y: Math.max(0, base.y + dy) } : { ...base, w: Math.max(200, base.w + dx), h: Math.max(140, base.h + dy) };
      setLive(latest);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setLive(null);
      if (latest !== base) onChange(latest);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div
      className={`chart-box ${selected ? 'on' : ''}`}
      style={{ left: HEADER_W + c.x, top: HEADER_H + c.y, width: c.w, height: c.h }}
      onMouseDown={(e) => start(e, 'move')}
      onDoubleClick={(e) => (e.stopPropagation(), onEdit())}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.stopPropagation();
          onDelete();
        }
      }}
    >
      <div className="chart-svg" dangerouslySetInnerHTML={{ __html: svg }} />
      {selected && (
        <>
          <div className="chart-tools" onMouseDown={(e) => e.stopPropagation()}>
            <button className="btn sm tonal" onClick={onEdit}>
              <Pencil size={13} /> Edit
            </button>
            <button className="icon-btn sm" title="Delete chart" onClick={onDelete}>
              <Trash2 size={14} />
            </button>
          </div>
          <div className="chart-resize" onMouseDown={(e) => start(e, 'resize')} />
        </>
      )}
    </div>
  );
}

const CellsLayer = memo(function CellsLayer({
  sheet,
  calc,
  geo,
  rows,
  cols,
  fz,
  mergeAt,
  editingKey,
  cf,
  checkboxAt
}: {
  sheet: Sheet;
  calc: Calc;
  geo: any;
  rows: number[];
  cols: number[];
  fz: { rows: number; cols: number };
  mergeAt: Map<string, Range>;
  editingKey: string;
  cf: (r: number, c: number) => CfResult | null;
  checkboxAt: (r: number, c: number) => boolean;
}) {
  const out: JSX.Element[] = [];
  const lastCol = cols[cols.length - 1];
  for (const r of rows) {
    const fr = r < fz.rows;
    for (let ci = 0; ci < cols.length; ci++) {
      const c = cols[ci];
      const k = key(r, c);
      const m = mergeAt.get(k);
      if (m && (m.r1 !== r || m.c1 !== c)) continue;
      const cell = sheet.cells[k];
      const fc = c < fz.cols;
      const left = HEADER_W + geo.colStart[c];
      const top = HEADER_H + geo.rowStart[r];
      const width = m ? geo.colStart[m.c2 + 1] - geo.colStart[c] : geo.cw(c);
      const height = m ? geo.rowStart[m.r2 + 1] - geo.rowStart[r] : geo.rh(r);
      const cls = `cell${fr ? ' fr' : ''}${fc ? ' fc' : ''}${m ? ' merged' : ''}`;
      const cfr = cf(r, c);
      const shadow = borderShadow(cell?.s);
      const isCb = checkboxAt(r, c);
      const spilled = !cell ? calc.value(sheet, r, c) : null;
      if ((!cell && (spilled === null || spilled === undefined) && !isCb) || k === editingKey) {
        out.push(<div key={k} className={cls} style={{ left, top, width, height, background: cfr?.bg ?? cell?.s?.bg, boxShadow: shadow }} />);
        continue;
      }
      const v = cell ? calc.value(sheet, r, c) : spilled;
      const s = cell?.s || {};
      if (isCb) {
        const on = v === true || v === 1 || (typeof v === 'string' && v.toUpperCase() === 'TRUE');
        out.push(
          <div key={k} className={cls} style={{ left, top, width, height, background: cfr?.bg ?? s.bg, boxShadow: shadow, justifyContent: 'center', alignItems: 'center' }}>
            <span className={`cb ${on ? 'on' : ''}`} data-cb={`${r},${c}`}>
              {on ? '✓' : ''}
            </span>
          </div>
        );
        continue;
      }
      const text = formatValue(v ?? null, s);
      const isNum = typeof v === 'number';
      const isErr = v instanceof FormulaError;
      const align = s.align || (isErr || typeof v === 'boolean' ? 'center' : isNum ? 'right' : 'left');
      // Let left-aligned text spill into empty neighbours, like Excel.
      let spill = width;
      if (!s.wrap && !m && align === 'left' && typeof v === 'string' && text.length * 6 > width) {
        for (let nc = c + 1; nc <= lastCol && nc < c + 30; nc++) {
          const nb = sheet.cells[key(r, nc)];
          if ((nb && (nb.v !== undefined && nb.v !== null && nb.v !== '' || nb.f !== undefined)) || mergeAt.has(key(r, nc))) break;
          spill += geo.cw(nc);
        }
      }
      const style: React.CSSProperties = {
        left,
        top,
        width,
        height,
        background: cfr?.bar
          ? `linear-gradient(90deg, ${cfr.bar.color}cc ${cfr.bar.pct}%, transparent ${cfr.bar.pct}%)${cfr.bg ?? s.bg ? `, ${cfr.bg ?? s.bg}` : ''}`
          : cfr?.bg ?? s.bg,
        boxShadow: shadow,
        color: isErr ? 'var(--danger)' : cfr?.color ?? s.color,
        fontWeight: s.b || cfr?.b ? 600 : undefined,
        fontStyle: s.i || cfr?.i ? 'italic' : undefined,
        textDecoration: [s.u ? 'underline' : '', s.s || cfr?.s ? 'line-through' : ''].filter(Boolean).join(' ') || undefined,
        fontSize: s.size ? `${s.size}pt` : undefined,
        fontFamily: s.font || undefined,
        justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start',
        alignItems: s.valign === 'top' ? 'flex-start' : s.valign === 'middle' || m ? 'center' : 'flex-end',
        zIndex: spill > width ? 1 : undefined
      };
      out.push(
        <div key={k} className={cls + (s.wrap ? ' wrap' : '') + (!cell ? ' spill' : '')} style={style}>
          <span className="ct" style={spill > width ? { width: spill, maxWidth: spill } : undefined}>
            {text}
          </span>
        </div>
      );
    }
  }
  return <>{out}</>;
});

// ---------- Toolbar ----------
function SheetToolbar(p: {
  style: CellStyle;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  applyStyle(patch: Partial<CellStyle> | ((s: CellStyle) => Partial<CellStyle>)): void;
  onSort(desc: boolean): void;
  onSum(): void;
  onMerge(): void;
  merged: boolean;
  freeze: { rows: number; cols: number };
  onFreeze(f: { rows: number; cols: number }): void;
  cur: Pos;
  onFind(): void;
  onSave(saveAs: boolean): void;
  onPrint(): void;
  onExportPdf(): void;
  onExportCsv(): void;
  onInsertFunction(name: string): void;
  onBorders(kind: 'all' | 'outer' | 'inner' | 'top' | 'bottom' | 'left' | 'right' | 'none', b: Border): void;
  onChart(): void;
  filterOn: boolean;
  onFilter(): void;
  onValidation(): void;
  onCondFormat(): void;
  onDedupe(): void;
  onPivot(): void;
}) {
  const [bStyle, setBStyle] = useState<Border['style']>('thin');
  const [bColor, setBColor] = useState('#000000');
  const s = p.style;
  const B = ({ on, title, onClick, children, disabled }: any) => (
    <button className={`icon-btn ${on ? 'active' : ''}`} title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
  const fmt = s.fmt || 'general';
  const decimals = (d: number) =>
    p.applyStyle((st) => {
      const cur = st.dp ?? (st.fmt === 'percent' || st.fmt === 'general' || !st.fmt ? 0 : 2);
      return { dp: clamp(cur + d, 0, 10), fmt: st.fmt && st.fmt !== 'general' ? st.fmt : 'number' };
    });
  return (
    <div className="toolbar">
      <B title="Undo (Ctrl+Z)" onClick={p.onUndo} disabled={!p.canUndo}>
        <Undo2 size={18} />
      </B>
      <B title="Redo (Ctrl+Y)" onClick={p.onRedo} disabled={!p.canRedo}>
        <Redo2 size={18} />
      </B>
      <div className="tb-sep" />
      <B on={fmt === 'currency'} title="Format as currency" onClick={() => p.applyStyle({ fmt: fmt === 'currency' ? 'general' : 'currency', dp: undefined })}>
        <DollarSign size={18} />
      </B>
      <B on={fmt === 'percent'} title="Format as percent" onClick={() => p.applyStyle({ fmt: fmt === 'percent' ? 'general' : 'percent', dp: undefined })}>
        <Percent size={18} />
      </B>
      <B title="Fewer decimal places" onClick={() => decimals(-1)}>
        <span className="tb-txt">.0</span>
      </B>
      <B title="More decimal places" onClick={() => decimals(1)}>
        <span className="tb-txt">.00</span>
      </B>
      <select
        className="select"
        style={{ width: 112 }}
        value={fmt}
        title="Number format"
        onChange={(e) => p.applyStyle({ fmt: e.target.value as NumFmt, dp: undefined, numFmt: undefined })}
      >
        <option value="general">Automatic</option>
        <option value="number">Number</option>
        <option value="currency">Currency</option>
        <option value="percent">Percent</option>
        <option value="date">Date</option>
        <option value="datetime">Date time</option>
        <option value="text">Plain text</option>
      </select>
      <div className="tb-sep" />
      <select className="select" style={{ width: 64 }} value={s.size || 11} title="Font size" onChange={(e) => p.applyStyle({ size: Number(e.target.value) === 11 ? undefined : Number(e.target.value) })}>
        {[8, 9, 10, 11, 12, 14, 16, 18, 24, 36].map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <B on={s.b} title="Bold (Ctrl+B)" onClick={() => p.applyStyle({ b: !s.b })}>
        <Bold size={18} />
      </B>
      <B on={s.i} title="Italic (Ctrl+I)" onClick={() => p.applyStyle({ i: !s.i })}>
        <Italic size={18} />
      </B>
      <B on={s.u} title="Underline (Ctrl+U)" onClick={() => p.applyStyle({ u: !s.u })}>
        <UIcon size={18} />
      </B>
      <B on={s.s} title="Strikethrough" onClick={() => p.applyStyle({ s: !s.s })}>
        <Strikethrough size={18} />
      </B>
      <ColorPicker title="Text color" icon={<Baseline size={18} />} value={s.color || null} allowNone noneLabel="Automatic" onChange={(c) => p.applyStyle({ color: c || undefined })} />
      <ColorPicker title="Fill color" icon={<PaintBucket size={18} />} value={s.bg || null} allowNone onChange={(c) => p.applyStyle({ bg: c || undefined })} />
      <div className="tb-sep" />
      <B on={s.align === 'left'} title="Align left" onClick={() => p.applyStyle({ align: s.align === 'left' ? undefined : 'left' })}>
        <AlignLeft size={18} />
      </B>
      <B on={s.align === 'center'} title="Center" onClick={() => p.applyStyle({ align: s.align === 'center' ? undefined : 'center' })}>
        <AlignCenter size={18} />
      </B>
      <B on={s.align === 'right'} title="Align right" onClick={() => p.applyStyle({ align: s.align === 'right' ? undefined : 'right' })}>
        <AlignRight size={18} />
      </B>
      <B on={s.wrap} title="Wrap text" onClick={() => p.applyStyle({ wrap: !s.wrap })}>
        <WrapText size={18} />
      </B>
      <B on={p.merged} title="Merge cells" onClick={p.onMerge}>
        <TableCellsMerge size={18} />
      </B>
      <MenuButton title="Borders" button={(open) => <button className={`icon-btn ${open ? 'active' : ''}`}><Grid3x3 size={18} /></button>}>
        {(close) => (
          <div style={{ minWidth: 220 }}>
            <div className="menu-title">Borders</div>
            {(
              [
                ['all', 'All borders'],
                ['outer', 'Outside borders'],
                ['inner', 'Inside borders'],
                ['top', 'Top'],
                ['bottom', 'Bottom'],
                ['left', 'Left'],
                ['right', 'Right'],
                ['none', 'No borders']
              ] as const
            ).map(([k, label]) => (
              <button key={k} className="menu-item" onClick={() => (p.onBorders(k, { style: bStyle, color: bColor }), close())}>
                {label}
              </button>
            ))}
            <div className="menu-sep" />
            <div className="dd-row" style={{ padding: '4px 10px 6px' }}>
              <select className="select" value={bStyle} onChange={(e) => setBStyle(e.target.value as Border['style'])}>
                <option value="thin">Thin</option>
                <option value="medium">Medium</option>
                <option value="thick">Thick</option>
                <option value="dashed">Dashed</option>
                <option value="dotted">Dotted</option>
                <option value="double">Double</option>
              </select>
              <input type="color" className="color-field" value={bColor} onChange={(e) => setBColor(e.target.value)} title="Border colour" />
            </div>
          </div>
        )}
      </MenuButton>
      <div className="tb-sep" />
      <B title="Sort A → Z by this column" onClick={() => p.onSort(false)}>
        <ArrowDownAZ size={18} />
      </B>
      <B title="Sort Z → A by this column" onClick={() => p.onSort(true)}>
        <ArrowUpAZ size={18} />
      </B>
      <B on={p.filterOn} title={p.filterOn ? 'Remove filter' : 'Filter'} onClick={p.onFilter}>
        <FilterIcon size={18} />
      </B>
      <B title="Insert chart" onClick={p.onChart}>
        <BarChart3 size={18} />
      </B>
      <MenuButton title="Data" button={(open) => <button className={`icon-btn ${open ? 'active' : ''}`}><Database size={18} /></button>}>
        {(close) => (
          <>
            <div className="menu-title">Data</div>
            <button className="menu-item" onClick={() => (p.onValidation(), close())}>
              <ListChecks size={16} /> Dropdowns &amp; validation…
            </button>
            <button className="menu-item" onClick={() => (p.onCondFormat(), close())}>
              <Paintbrush size={16} /> Conditional formatting…
            </button>
            <button className="menu-item" onClick={() => (p.onPivot(), close())}>
              <TableProperties size={16} /> Summarize (pivot table)…
            </button>
            <button className="menu-item" onClick={() => (p.onDedupe(), close())}>
              <CopyMinus size={16} /> Remove duplicate rows
            </button>
          </>
        )}
      </MenuButton>
      <MenuButton title="Freeze rows / columns" button={(open) => <button className={`icon-btn ${open || p.freeze.rows || p.freeze.cols ? 'active' : ''}`}><Snowflake size={18} /></button>}>
        {(close) => (
          <>
            <div className="menu-title">Freeze rows</div>
            {[0, 1, 2].map((n) => (
              <button key={n} className="menu-item" onClick={() => (p.onFreeze({ ...p.freeze, rows: n }), close())}>
                <span style={{ width: 14 }}>{p.freeze.rows === n ? '✓' : ''}</span> {n === 0 ? 'No rows' : `${n} row${n > 1 ? 's' : ''}`}
              </button>
            ))}
            {p.cur.r > 1 && (
              <button className="menu-item" onClick={() => (p.onFreeze({ ...p.freeze, rows: p.cur.r }), close())}>
                <span style={{ width: 14 }}>{p.freeze.rows === p.cur.r ? '✓' : ''}</span> Up to row {p.cur.r}
              </button>
            )}
            <div className="menu-sep" />
            <div className="menu-title">Freeze columns</div>
            {[0, 1, 2].map((n) => (
              <button key={n} className="menu-item" onClick={() => (p.onFreeze({ ...p.freeze, cols: n }), close())}>
                <span style={{ width: 14 }}>{p.freeze.cols === n ? '✓' : ''}</span> {n === 0 ? 'No columns' : `${n} column${n > 1 ? 's' : ''}`}
              </button>
            ))}
            {p.cur.c > 1 && (
              <button className="menu-item" onClick={() => (p.onFreeze({ ...p.freeze, cols: p.cur.c }), close())}>
                <span style={{ width: 14 }}>{p.freeze.cols === p.cur.c ? '✓' : ''}</span> Up to column {colName(p.cur.c - 1)}
              </button>
            )}
          </>
        )}
      </MenuButton>
      <MenuButton title="Functions" button={(open) => <button className={`icon-btn ${open ? 'active' : ''}`}><Sigma size={18} /></button>}>
        {(close) => (
          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            <button className="menu-item" onClick={() => (p.onSum(), close())}>
              <Sigma size={16} /> AutoSum
            </button>
            <div className="menu-sep" />
            {['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN', 'IF', 'SUMIF', 'COUNTIF', 'VLOOKUP', 'XLOOKUP', 'INDEX', 'MATCH', 'ROUND', 'CONCAT', 'TEXT', 'TODAY', 'IFERROR'].map((f) => (
              <button key={f} className="menu-item" onClick={() => (p.onInsertFunction(f), close())}>
                {f}
              </button>
            ))}
          </div>
        )}
      </MenuButton>
      <div className="tb-spacer" />
      <B title="Find (Ctrl+F)" onClick={p.onFind}>
        <Search size={18} />
      </B>
      <div className="tb-sep" />
      <div className="tb-end">
      <LookupButton />
      <AssistantButton />
      <button className="btn primary sm" onMouseDown={(e) => e.preventDefault()} onClick={() => p.onSave(false)} title="Save (Ctrl+S)">
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
            <button className="menu-item" onClick={() => (p.onSave(true), close())}>
              <Save size={16} /> Save as… <span className="kbd">Ctrl+Shift+S</span>
            </button>
            <button className="menu-item" onClick={() => (p.onExportCsv(), close())}>
              <FileDown size={16} /> Export sheet as CSV…
            </button>
            <button className="menu-item" onClick={() => (p.onExportPdf(), close())}>
              <FileDown size={16} /> Export sheet as PDF…
            </button>
            <button className="menu-item" onClick={() => (p.onPrint(), close())}>
              <Printer size={16} /> Print… <span className="kbd">Ctrl+P</span>
            </button>
          </>
        )}
      </MenuButton>
      </div>
    </div>
  );
}

function FindBar({ sheet, calc, onClose, onGo, onReplaceAll }: { sheet: Sheet; calc: Calc; onClose(): void; onGo(p: Pos): void; onReplaceAll(q: string, rep: string): void }) {
  const [q, setQ] = useState('');
  const [rep, setRep] = useState('');
  const [idx, setIdx] = useState(0);
  const [showRep, setShowRep] = useState(false);
  const matches = useMemo(() => {
    if (!q) return [];
    const ql = q.toLowerCase();
    const out: Pos[] = [];
    for (const k in sheet.cells) {
      const { r, c } = parseKey(k);
      const v = formatValue(calc.value(sheet, r, c), sheet.cells[k].s);
      if (v.toLowerCase().includes(ql)) out.push({ r, c });
    }
    return out.sort((a, b) => a.r - b.r || a.c - b.c);
  }, [q, sheet, calc]);
  useEffect(() => {
    setIdx(0);
    if (matches.length) onGo(matches[0]);
  }, [matches]);
  const step = (d: number) => {
    if (!matches.length) return;
    const i = (idx + d + matches.length) % matches.length;
    setIdx(i);
    onGo(matches[i]);
  };
  return (
    <div className="find-bar sheet-find">
      <div className="find-row">
        <Search size={16} color="var(--text-3)" />
        <input
          autoFocus
          placeholder="Find in sheet"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
            if (e.key === 'Escape') onClose();
          }}
        />
        <span className="tb-label">{q ? (matches.length ? `${idx + 1} of ${matches.length}` : 'No results') : ''}</span>
        <button className="icon-btn sm" onClick={() => step(-1)} disabled={!matches.length}>
          <ChevronUp size={16} />
        </button>
        <button className="icon-btn sm" onClick={() => step(1)} disabled={!matches.length}>
          <ChevronDown size={16} />
        </button>
        <button className={`icon-btn sm ${showRep ? 'active' : ''}`} title="Replace" onClick={() => setShowRep((s) => !s)}>
          <span style={{ fontSize: 11, fontWeight: 600 }}>A→B</span>
        </button>
        <button className="icon-btn sm" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {showRep && (
        <div className="find-row">
          <span style={{ width: 16 }} />
          <input placeholder="Replace with" value={rep} onChange={(e) => setRep(e.target.value)} />
          <button className="btn sm tonal" disabled={!q} onClick={() => onReplaceAll(q, rep)}>
            Replace all
          </button>
        </div>
      )}
    </div>
  );
}

export { dateToSerial };

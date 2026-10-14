import { evaluateRaw, FormulaError, Scalar, formatGeneral, formatWithPattern, serialToDate, dateToSerial, addr } from './formula';

export type NumFmt = 'general' | 'number' | 'currency' | 'percent' | 'date' | 'datetime' | 'text';

export interface CellStyle {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  color?: string;
  bg?: string;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  wrap?: boolean;
  fmt?: NumFmt;
  dp?: number;
  /** Original Excel format code, kept for round-tripping. */
  numFmt?: string;
  size?: number;
  font?: string;
  /** Borders: top, bottom, left, right. */
  bt?: Border;
  bb?: Border;
  bl?: Border;
  br?: Border;
}

export interface Border {
  style: 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double';
  color?: string;
}

export interface Range {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export type ChartType = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter';
export interface Chart {
  id: string;
  type: ChartType;
  range: Range;
  title?: string;
  /** Position and size in pixels over the grid. */
  x: number;
  y: number;
  w: number;
  h: number;
  legend?: 'right' | 'bottom' | 'top' | 'none';
  /** First row holds series names / first column holds category labels. */
  headerRow?: boolean;
  labelCol?: boolean;
  seriesBy?: 'cols' | 'rows';
  stacked?: boolean;
  showValues?: boolean;
  xTitle?: string;
  yTitle?: string;
  colors?: string[];
  smooth?: boolean;
}

export interface Validation {
  id: string;
  range: Range;
  type: 'list' | 'checkbox' | 'number' | 'date' | 'textLength';
  /** List items, or a range like "Sheet2!A1:A10" to take items from. */
  values?: string[];
  source?: string;
  min?: number | null;
  max?: number | null;
  /** Reject invalid input (otherwise just warn). */
  strict?: boolean;
  help?: string;
}

export type CondType = 'gt' | 'lt' | 'gte' | 'lte' | 'between' | 'eq' | 'neq' | 'contains' | 'notContains' | 'startsWith' | 'empty' | 'notEmpty' | 'dup' | 'unique' | 'top' | 'bottom' | 'aboveAvg' | 'belowAvg' | 'scale' | 'bars' | 'formula';
export interface CondRule {
  id: string;
  range: Range;
  type: CondType;
  a?: string;
  b?: string;
  n?: number;
  /** Formatting applied when the rule matches. */
  style?: { bg?: string; color?: string; b?: boolean; i?: boolean; s?: boolean };
  /** Colour scale (2 or 3 colours, low → high) or data-bar colour. */
  colors?: string[];
}

export interface FilterState {
  /** The filtered table, including its header row. */
  range: Range;
  /** Per column (absolute index): values hidden, or a condition. */
  cols: Record<number, { hide?: string[]; cond?: { type: CondType; a?: string; b?: string } }>;
}

export interface Cell {
  v?: number | string | boolean | null;
  f?: string; // formula without the leading '='
  s?: CellStyle;
}

export interface Sheet {
  id: string;
  name: string;
  cells: Record<string, Cell>; // key "r,c"
  colW: Record<number, number>;
  rowH: Record<number, number>;
  freeze: { rows: number; cols: number };
  merges?: { r1: number; c1: number; r2: number; c2: number }[];
  charts?: Chart[];
  validations?: Validation[];
  condRules?: CondRule[];
  filter?: FilterState | null;
  /** Rows hidden by the filter or by hand. */
  hiddenRows?: Record<number, true>;
  hiddenCols?: Record<number, true>;
  gridlines?: boolean;
}

export interface Workbook {
  sheets: Sheet[];
}

export const DEFAULT_COL_W = 100;
export const DEFAULT_ROW_H = 24;
export const HEADER_W = 46;
export const HEADER_H = 24;
export const MIN_ROWS = 200;
export const MIN_COLS = 26;

export const key = (r: number, c: number) => `${r},${c}`;
export const parseKey = (k: string) => {
  const i = k.indexOf(',');
  return { r: +k.slice(0, i), c: +k.slice(i + 1) };
};

export function newSheet(name: string, id = Math.random().toString(36).slice(2)): Sheet {
  return { id, name, cells: {}, colW: {}, rowH: {}, freeze: { rows: 0, cols: 0 } };
}

export function usedRange(sheet: Sheet) {
  let rows = 0,
    cols = 0;
  for (const k in sheet.cells) {
    const c = sheet.cells[k];
    if (c.v === undefined && c.f === undefined && !c.s) continue;
    const p = parseKey(k);
    if (p.r + 1 > rows) rows = p.r + 1;
    if (p.c + 1 > cols) cols = p.c + 1;
  }
  return { rows, cols };
}

// ---------- Input parsing ----------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Interpret what the user typed, the way a spreadsheet would. */
export function parseInput(raw: string, current?: CellStyle): { cell: Cell; fmt?: Partial<CellStyle> } {
  if (raw === '') return { cell: {} };
  if (raw.startsWith("'")) return { cell: { v: raw.slice(1) } };
  if (raw.startsWith('=') && raw.length > 1) return { cell: { f: raw.slice(1) } };
  if (current?.fmt === 'text') return { cell: { v: raw } };
  const t = raw.trim();
  if (/^(true|false)$/i.test(t)) return { cell: { v: t.toLowerCase() === 'true' } };
  let m = t.match(/^([-+]?)\$\s?(\d{1,3}(,\d{3})+|\d*)(\.\d+)?$/);
  if (m && (m[2] || m[4])) {
    const n = parseFloat((m[1] || '') + (m[2] || '0').replace(/,/g, '') + (m[4] || ''));
    return { cell: { v: n }, fmt: current?.fmt && current.fmt !== 'general' ? undefined : { fmt: 'currency', dp: 2 } };
  }
  m = t.match(/^([-+]?(\d{1,3}(,\d{3})+|\d*)(\.\d+)?)\s?%$/);
  if (m && (m[2] || m[4])) {
    const n = parseFloat(m[1].replace(/,/g, '')) / 100;
    return { cell: { v: n }, fmt: current?.fmt && current.fmt !== 'general' ? undefined : { fmt: 'percent', dp: (m[4]?.length || 1) - 1 } };
  }
  if (/^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][-+]?\d+)?$/.test(t) && /\d/.test(t)) {
    return { cell: { v: parseFloat(t.replace(/,/g, '')) } };
  }
  // Dates: 2024-03-15, 3/15/2024, 3/15, Mar 15 2024, 15-Mar-2024
  let d: Date | null = null;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) d = new Date(+m[1], +m[2] - 1, +m[3]);
  else if ((m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/))) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : new Date().getFullYear();
    d = new Date(y, +m[1] - 1, +m[2]);
  } else if ((m = t.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/)) && MONTHS.includes(m[1].toLowerCase())) {
    d = new Date(+m[3], MONTHS.indexOf(m[1].toLowerCase()), +m[2]);
  } else if ((m = t.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/)) && MONTHS.includes(m[2].toLowerCase())) {
    d = new Date(m[3].length === 2 ? 2000 + +m[3] : +m[3], MONTHS.indexOf(m[2].toLowerCase()), +m[1]);
  }
  if (d && !isNaN(d.getTime())) return { cell: { v: Math.round(dateToSerial(d)) }, fmt: current?.fmt === 'date' ? undefined : { fmt: 'date' } };
  return { cell: { v: raw } };
}

/** Text shown in the formula bar / editor for a cell. */
export function editText(cell: Cell | undefined): string {
  if (!cell) return '';
  if (cell.f !== undefined) return '=' + cell.f;
  if (cell.v === null || cell.v === undefined) return '';
  if (typeof cell.v === 'boolean') return cell.v ? 'TRUE' : 'FALSE';
  if (typeof cell.v === 'number') {
    const f = cell.s?.fmt;
    if (f === 'date' || f === 'datetime') return formatDate(cell.v, f === 'datetime');
    if (f === 'percent') return formatGeneral(cell.v * 100) + '%';
    return formatGeneral(cell.v);
  }
  return String(cell.v);
}

function formatDate(n: number, withTime: boolean) {
  const d = serialToDate(n);
  const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  if (!withTime) return date;
  return `${date} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Display string for a computed value. */
export function formatValue(v: Scalar, s?: CellStyle): string {
  if (v === null || v === undefined) return '';
  if (v instanceof FormulaError) return v.code;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  const fmt = s?.fmt || 'general';
  const dp = s?.dp;
  switch (fmt) {
    case 'number':
      return v.toLocaleString('en-US', { minimumFractionDigits: dp ?? 2, maximumFractionDigits: dp ?? 2 });
    case 'currency': {
      const body = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp ?? 2, maximumFractionDigits: dp ?? 2 });
      return (v < 0 ? '-$' : '$') + body;
    }
    case 'percent':
      return (v * 100).toLocaleString('en-US', { minimumFractionDigits: dp ?? 0, maximumFractionDigits: dp ?? 0 }) + '%';
    case 'date':
      return formatDate(v, false);
    case 'datetime':
      return formatDate(v, true);
    default:
      if (s?.numFmt && s.numFmt !== 'General') {
        try {
          return formatWithPattern(v, s.numFmt);
        } catch {}
      }
      if (dp !== undefined) return v.toFixed(dp);
      return formatGeneral(v);
  }
}

// ---------- Calculation ----------
/**
 * Computes cell values on demand with memoisation. A new Calc is created
 * whenever the workbook changes, which keeps invalidation trivially correct.
 */
export class Calc {
  private cache = new Map<string, Scalar>();
  private stack = new Set<string>();
  private byName = new Map<string, Sheet>();
  private used = new Map<string, number>();
  /** Spilled array results: "sheetId|r,c" → value, for cells filled by a formula above/left of them. */
  private spills = new Map<string, Scalar>();
  private spillPrepared = new Set<string>();
  /** Anchor cell → size of its spill, so the grid can outline it. */
  readonly spillAreas = new Map<string, { rows: number; cols: number }>();

  constructor(private wb: Workbook) {
    for (const s of wb.sheets) this.byName.set(s.name.toLowerCase(), s);
  }

  /** Evaluate array formulas first so the cells they spill into have values. */
  private prepareSpills(sheet: Sheet) {
    if (this.spillPrepared.has(sheet.id)) return;
    this.spillPrepared.add(sheet.id);
    for (const k in sheet.cells) {
      const cell = sheet.cells[k];
      if (cell.f && SPILL_FN.test(cell.f)) {
        const { r, c } = parseKey(k);
        this.value(sheet, r, c);
      }
    }
  }

  value(sheet: Sheet, r: number, c: number): Scalar {
    const k = `${sheet.id}|${r},${c}`;
    const hit = this.cache.get(k);
    if (hit !== undefined) return hit;
    this.prepareSpills(sheet);
    const cell = sheet.cells[`${r},${c}`];
    if (!cell || (cell.f === undefined && (cell.v === undefined || cell.v === null))) {
      const sp = this.spills.get(k);
      return sp === undefined ? null : sp;
    }
    if (cell.f === undefined) return cell.v as Scalar;
    if (this.stack.has(k)) return new FormulaError('#CIRC!');
    this.stack.add(k);
    const self = this;
    const raw = evaluateRaw(cell.f, {
      cell(sheetName, rr, cc) {
        const target = sheetName ? self.byName.get(sheetName.toLowerCase()) : sheet;
        if (!target) return new FormulaError('#REF!');
        return self.value(target, rr, cc);
      },
      usedRows(sheetName) {
        const target = sheetName ? self.byName.get(sheetName.toLowerCase()) : sheet;
        if (!target) return 0;
        let n = self.used.get(target.id);
        if (n === undefined) {
          n = usedRange(target).rows;
          self.used.set(target.id, n);
        }
        return n;
      },
      sheetExists: (name) => self.byName.has(name.toLowerCase())
    });
    let v: Scalar;
    if (Array.isArray(raw)) {
      v = raw[0]?.[0] ?? null;
      const h = raw.length;
      const w = Math.max(0, ...raw.map((row) => row.length));
      if (h > 1 || w > 1) {
        // Spill into the neighbouring cells unless something is in the way.
        let blocked = false;
        for (let i = 0; i < h && !blocked; i++)
          for (let j = 0; j < w; j++) {
            if (!i && !j) continue;
            const nb = sheet.cells[`${r + i},${c + j}`];
            if (nb && (nb.f !== undefined || (nb.v !== undefined && nb.v !== null && nb.v !== ''))) {
              blocked = true;
              break;
            }
          }
        if (blocked) v = new FormulaError('#SPILL!');
        else {
          for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) if (i || j) this.spills.set(`${sheet.id}|${r + i},${c + j}`, raw[i]?.[j] ?? null);
          this.spillAreas.set(`${sheet.id}|${r},${c}`, { rows: h, cols: w });
        }
      }
    } else v = raw;
    if (v === null) v = 0;
    if (typeof v === 'number' && !isFinite(v)) v = new FormulaError('#NUM!');
    this.stack.delete(k);
    this.cache.set(k, v);
    return v;
  }
}

const SPILL_FN = /\b(FILTER|SORT|SORTBY|UNIQUE|SEQUENCE|TRANSPOSE|RANDARRAY)\s*\(/i;

export { addr };

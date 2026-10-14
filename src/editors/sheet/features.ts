import type { Sheet, Workbook, CondRule, Validation, FilterState, Range, CondType } from './model';
import { Calc, formatValue, key } from './model';
import { FormulaError, compare, parseAddr, evaluate } from './formula';

/**
 * Conditional formatting, filters and data validation. All of these read cell values through Calc,
 * so formulas count, and none of them change the cells themselves.
 */

const inRange = (r: number, c: number, g: Range) => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2;
const display = (sheet: Sheet, calc: Calc, r: number, c: number) => formatValue(calc.value(sheet, r, c), sheet.cells[key(r, c)]?.s);

export interface CfResult {
  bg?: string;
  color?: string;
  b?: boolean;
  i?: boolean;
  s?: boolean;
  bar?: { pct: number; color: string };
}

function hexToRgb(h: string) {
  const n = parseInt(h.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(', ')})`;
}

/** Does a single value pass a comparison rule? (shared by conditional formatting and filters) */
export function testValue(type: CondType, v: unknown, text: string, a?: string, b?: string): boolean {
  const num = (s?: string) => (s === undefined || s === '' || isNaN(Number(s)) ? s : Number(s));
  const A = num(a) as any;
  const B = num(b) as any;
  const val = v instanceof FormulaError ? null : (v as any);
  switch (type) {
    case 'gt':
      return val !== null && compare(val, A) > 0;
    case 'lt':
      return val !== null && compare(val, A) < 0;
    case 'gte':
      return val !== null && compare(val, A) >= 0;
    case 'lte':
      return val !== null && compare(val, A) <= 0;
    case 'between':
      return val !== null && compare(val, A) >= 0 && compare(val, B) <= 0;
    case 'eq':
      return compare(val, A) === 0;
    case 'neq':
      return compare(val, A) !== 0;
    case 'contains':
      return text.toLowerCase().includes(String(a || '').toLowerCase());
    case 'notContains':
      return !text.toLowerCase().includes(String(a || '').toLowerCase());
    case 'startsWith':
      return text.toLowerCase().startsWith(String(a || '').toLowerCase());
    case 'empty':
      return text === '';
    case 'notEmpty':
      return text !== '';
    default:
      return false;
  }
}

/** Conditional formatting for a sheet: returns a lookup from cell to the formatting to apply. */
export function conditionalFormats(sheet: Sheet, calc: Calc): (r: number, c: number) => CfResult | null {
  const rules = sheet.condRules || [];
  if (!rules.length) return () => null;
  // Pre-compute what each rule needs from its whole range (min/max, averages, duplicates, top N).
  const prepared = rules.map((rule) => {
    const vals: { r: number; c: number; v: unknown; text: string }[] = [];
    const { r1, c1 } = rule.range;
    const r2 = Math.min(rule.range.r2, r1 + 5000);
    const c2 = Math.min(rule.range.c2, c1 + 200);
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) vals.push({ r, c, v: calc.value(sheet, r, c), text: display(sheet, calc, r, c) });
    const numsAll = vals.map((x) => x.v).filter((v): v is number => typeof v === 'number');
    const sorted = [...numsAll].sort((a, b) => a - b);
    const counts = new Map<string, number>();
    for (const x of vals) if (x.text !== '') counts.set(x.text.toLowerCase(), (counts.get(x.text.toLowerCase()) || 0) + 1);
    const n = rule.n || 10;
    return {
      rule,
      min: sorted[0] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
      avg: numsAll.length ? numsAll.reduce((s, x) => s + x, 0) / numsAll.length : 0,
      topCut: sorted[Math.max(0, sorted.length - n)] ?? Infinity,
      botCut: sorted[Math.min(sorted.length - 1, n - 1)] ?? -Infinity,
      counts
    };
  });
  return (r, c) => {
    let out: CfResult | null = null;
    for (const p of prepared) {
      const { rule } = p;
      if (!inRange(r, c, rule.range)) continue;
      const v = calc.value(sheet, r, c);
      const text = display(sheet, calc, r, c);
      const isNum = typeof v === 'number';
      if (rule.type === 'scale') {
        if (!isNum || p.max === p.min) continue;
        const t = ((v as number) - p.min) / (p.max - p.min);
        const cols = rule.colors?.length ? rule.colors : ['#f8696b', '#ffeb84', '#63be7b'];
        const bg = cols.length >= 3 ? (t < 0.5 ? mix(cols[0], cols[1], t * 2) : mix(cols[1], cols[2], (t - 0.5) * 2)) : mix(cols[0], cols[1], t);
        out = { ...(out || {}), bg, color: '#111' };
        continue;
      }
      if (rule.type === 'bars') {
        if (!isNum) continue;
        const lo = Math.min(0, p.min);
        const pct = p.max === lo ? 0 : (((v as number) - lo) / (p.max - lo)) * 100;
        out = { ...(out || {}), bar: { pct: Math.max(0, Math.min(100, pct)), color: rule.colors?.[0] || '#638ec6' } };
        continue;
      }
      let hit = false;
      switch (rule.type) {
        case 'dup':
          hit = text !== '' && (p.counts.get(text.toLowerCase()) || 0) > 1;
          break;
        case 'unique':
          hit = text !== '' && p.counts.get(text.toLowerCase()) === 1;
          break;
        case 'top':
          hit = isNum && (v as number) >= p.topCut;
          break;
        case 'bottom':
          hit = isNum && (v as number) <= p.botCut;
          break;
        case 'aboveAvg':
          hit = isNum && (v as number) > p.avg;
          break;
        case 'belowAvg':
          hit = isNum && (v as number) < p.avg;
          break;
        case 'formula': {
          // Formula relative to the rule's first cell, like Excel: =B2>100 applies to each cell.
          try {
            const res = evaluate(shiftRefs(rule.a || 'FALSE', r - rule.range.r1, c - rule.range.c1), {
              cell: (_s, rr, cc) => calc.value(sheet, rr, cc),
              usedRows: () => 100000,
              sheetExists: () => true
            });
            hit = res === true || (typeof res === 'number' && res !== 0);
          } catch {}
          break;
        }
        default:
          hit = testValue(rule.type, v, text, rule.a, rule.b);
      }
      if (hit) out = { ...(out || {}), ...(rule.style || { bg: '#f4c7c3', color: '#8a1c13' }) };
    }
    return out;
  };
}

/** Move relative references in a formula by (dr, dc). */
function shiftRefs(f: string, dr: number, dc: number) {
  if (!dr && !dc) return f;
  return f.replace(/(\$?)([A-Za-z]{1,3})(\$?)(\d+)/g, (m, ac, col, ar, row) => {
    const p = parseAddr(`${col}${row}`);
    if (!p) return m;
    const c = ac ? p.c : p.c + dc;
    const r = ar ? p.r : p.r + dr;
    let name = '';
    let n = c + 1;
    while (n > 0) {
      const rem = (n - 1) % 26;
      name = String.fromCharCode(65 + rem) + name;
      n = Math.floor((n - 1) / 26);
    }
    return `${ac}${name}${ar}${r + 1}`;
  });
}

// ---------- Filters ----------
/** The block of filled cells around a cell (what a filter or chart should cover by default). */
export function currentRegion(sheet: Sheet, r: number, c: number): Range {
  const filled = (rr: number, cc: number) => {
    const cell = sheet.cells[key(rr, cc)];
    return !!cell && (cell.f !== undefined || (cell.v !== undefined && cell.v !== null && cell.v !== ''));
  };
  let g = { r1: r, c1: c, r2: r, c2: c };
  for (let pass = 0; pass < 50; pass++) {
    let grown = false;
    const tryGrow = (next: Range) => {
      for (let rr = next.r1; rr <= next.r2; rr++)
        for (let cc = next.c1; cc <= next.c2; cc++)
          if (!inRange(rr, cc, g) && filled(rr, cc)) {
            g = next;
            grown = true;
            return;
          }
    };
    if (g.r1 > 0) tryGrow({ ...g, r1: g.r1 - 1 });
    tryGrow({ ...g, r2: g.r2 + 1 });
    if (g.c1 > 0) tryGrow({ ...g, c1: g.c1 - 1 });
    tryGrow({ ...g, c2: g.c2 + 1 });
    if (!grown) break;
  }
  return g;
}

/** Distinct values in a filter column (as displayed), with counts. */
export function columnValues(sheet: Sheet, calc: Calc, f: FilterState, col: number) {
  const counts = new Map<string, number>();
  for (let r = f.range.r1 + 1; r <= f.range.r2; r++) {
    const t = display(sheet, calc, r, col);
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0], undefined, { numeric: true })));
}

/** Rows hidden by a filter. */
export function filteredRows(sheet: Sheet, calc: Calc, f: FilterState): Record<number, true> {
  const hidden: Record<number, true> = {};
  for (let r = f.range.r1 + 1; r <= f.range.r2; r++) {
    for (const [cs, crit] of Object.entries(f.cols)) {
      const c = Number(cs);
      const text = display(sheet, calc, r, c);
      if (crit.hide?.includes(text) || (crit.cond && !testValue(crit.cond.type, calc.value(sheet, r, c), text, crit.cond.a, crit.cond.b))) {
        hidden[r] = true;
        break;
      }
    }
  }
  return hidden;
}

// ---------- Data validation ----------
export const validationAt = (sheet: Sheet, r: number, c: number): Validation | undefined => (sheet.validations || []).find((v) => inRange(r, c, v.range));

/** Items for a dropdown list (typed values or a range of cells). */
export function listItems(v: Validation, wb: Workbook, calc: Calc, current: Sheet): string[] {
  if (v.values?.length) return v.values;
  if (!v.source) return [];
  const [sheetPart, ref] = v.source.includes('!') ? [v.source.slice(0, v.source.lastIndexOf('!')).replace(/^'|'$/g, ''), v.source.slice(v.source.lastIndexOf('!') + 1)] : [null, v.source];
  const sheet = sheetPart ? wb.sheets.find((s) => s.name.toLowerCase() === sheetPart.toLowerCase()) : current;
  if (!sheet) return [];
  const [a, b] = ref.replace(/\$/g, '').split(':').map(parseAddr);
  if (!a) return [];
  const end = b || a;
  const out: string[] = [];
  for (let r = a.r; r <= end.r; r++) for (let c = a.c; c <= end.c; c++) {
    const t = display(sheet, calc, r, c);
    if (t !== '' && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Why a value breaks a validation rule (or null if it's fine). */
export function invalidReason(v: Validation, raw: string, wb: Workbook, calc: Calc, sheet: Sheet): string | null {
  if (raw === '') return null;
  switch (v.type) {
    case 'list': {
      const items = listItems(v, wb, calc, sheet);
      return items.some((i) => i.toLowerCase() === raw.toLowerCase()) ? null : `Pick one of: ${items.slice(0, 8).join(', ')}${items.length > 8 ? '…' : ''}`;
    }
    case 'checkbox':
      return /^(true|false)$/i.test(raw) ? null : 'This cell is a checkbox (TRUE or FALSE).';
    case 'number':
    case 'textLength': {
      const n = v.type === 'textLength' ? raw.length : Number(raw.replace(/[,$%]/g, ''));
      if (isNaN(n)) return 'Enter a number.';
      if (v.min != null && n < v.min) return v.type === 'textLength' ? `At least ${v.min} characters.` : `Must be at least ${v.min}.`;
      if (v.max != null && n > v.max) return v.type === 'textLength' ? `At most ${v.max} characters.` : `Must be at most ${v.max}.`;
      return null;
    }
    case 'date':
      return /\d/.test(raw) && !isNaN(Date.parse(raw)) ? null : 'Enter a date.';
  }
  return null;
}

export { inRange };

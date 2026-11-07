// CSV and TSV files: read into a sheet, and written back so that every cell nobody edited comes out exactly as it
// went in (dates stay 2026-11-01, "007" stays 007, quotes, separators and line endings stay the file's own).
// Kept apart from io.ts (no Excel libraries) so it can be tested on its own.
import { Sheet, Cell, CellStyle, Workbook, newSheet, key, parseKey, parseInput, Calc, formatValue } from './model';
import { serialToDate } from './formula';

/** How the file was written, so saving writes it the same way. */
export interface CsvLayout {
  delim: string;
  eol: string;
  /** The last line ended with a line break. */
  finalEol: boolean;
  bom: boolean;
  latin1: boolean;
  /** Fields on each line of the file as read. */
  widths: number[];
  /** Blank lines at the end of the file. */
  trailingBlank: number;
}

export function detectDelim(text: string) {
  const first = text.slice(0, 2000).split(/\r?\n/)[0] || '';
  const counts = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][1] > 1 ? counts[0][0] : ',';
}

/** Split CSV text into fields; `quoted` says which fields were in quotes. */
export function parseCsvDetailed(text: string, delim?: string): { rows: string[][]; quoted: boolean[][]; delim: string } {
  const d = delim || detectDelim(text);
  const rows: string[][] = [];
  const quoted: boolean[][] = [];
  let row: string[] = [];
  let qrow: boolean[] = [];
  let field = '';
  let wasQuoted = false;
  let q = false;
  const endField = () => {
    row.push(field);
    qrow.push(wasQuoted);
    field = '';
    wasQuoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
    } else if (ch === '"' && field === '' && !wasQuoted) {
      q = true;
      wasQuoted = true;
    } else if (ch === d) endField();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endField();
      rows.push(row);
      quoted.push(qrow);
      row = [];
      qrow = [];
    } else field += ch;
  }
  if (field !== '' || wasQuoted || row.length) {
    endField();
    rows.push(row);
    quoted.push(qrow);
  }
  return { rows, quoted, delim: d };
}

export function parseCsv(text: string, delim?: string): string[][] {
  return parseCsvDetailed(text, delim).rows;
}

/** The cell a CSV field becomes (the same rules as typing it, except leading zeros and "=" stay text). */
export function cellFromField(raw: string): Cell {
  if (/^0\d+$/.test(raw.trim()) || raw.startsWith('=')) return { v: raw };
  const parsed = parseInput(raw);
  return parsed.fmt ? { ...parsed.cell, s: parsed.fmt as CellStyle } : parsed.cell;
}

const hasBom = (b: Uint8Array) => b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;

export function decodeCsv(bytes: Uint8Array): { text: string; bom: boolean; latin1: boolean } {
  const bom = hasBom(bytes);
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text: t.charCodeAt(0) === 0xfeff ? t.slice(1) : t, bom, latin1: false };
  } catch {
    return { text: new TextDecoder('latin1').decode(bytes), bom: false, latin1: true };
  }
}

export function readCsvSheet(bytes: Uint8Array, delim: string | undefined, name: string): Sheet {
  const { text, bom, latin1 } = decodeCsv(bytes);
  const sheet = newSheet(name.replace(/\.[^.]+$/, '').slice(0, 31) || 'Sheet1');
  const parsed = parseCsvDetailed(text, delim);
  parsed.rows.forEach((row, r) =>
    row.forEach((raw, c) => {
      if (raw === '' && !parsed.quoted[r][c]) return;
      // Remember the field as written, so an unedited cell is saved back exactly.
      sheet.cells[key(r, c)] = { ...cellFromField(raw), orig: raw, ...(parsed.quoted[r][c] ? { origQ: true } : {}) };
    })
  );
  let trailingBlank = 0;
  for (let r = parsed.rows.length - 1; r >= 0 && parsed.rows[r].every((f) => f === ''); r--) trailingBlank++;
  const eol = /\r\n/.test(text) ? '\r\n' : /\n/.test(text) ? '\n' : /\r/.test(text) ? '\r' : '\r\n';
  sheet.csv = {
    delim: parsed.delim,
    eol,
    finalEol: !text.length || /[\r\n]$/.test(text),
    bom,
    latin1,
    widths: parsed.rows.map((r) => r.length),
    trailingBlank
  };
  return sheet;
}

/** Still holds what the file had (only its look may have changed: bold, colours and so on). */
function unedited(cell: Cell) {
  if (cell.orig === undefined || cell.f !== undefined) return false;
  const was = cellFromField(cell.orig);
  if (was.v !== cell.v) return false;
  const a = cell.s || {};
  const b = was.s || {};
  return (a.fmt || 'general') === (b.fmt || 'general') && a.dp === b.dp && a.numFmt === b.numFmt;
}

const pad = (n: number) => String(n).padStart(2, '0');
function isoDate(serial: number, withTime: boolean) {
  const d = serialToDate(serial);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

/** The text a cell is written as. */
function fieldText(calc: Calc, sheet: Sheet, r: number, c: number): { text: string; quote: boolean } {
  const cell = sheet.cells[key(r, c)];
  if (!cell) return { text: '', quote: false };
  if (unedited(cell)) return { text: cell.orig!, quote: !!cell.origQ };
  const v = calc.value(sheet, r, c);
  const fmt = cell.s?.fmt;
  let s: string;
  if (v === null || v === undefined) s = '';
  // Dates are written the way other programs read them: 2026-11-01.
  else if (typeof v === 'number' && (fmt === 'date' || fmt === 'datetime')) s = isoDate(v, fmt === 'datetime');
  else if (typeof v === 'number' && (!fmt || fmt === 'general')) s = String(v);
  else s = formatValue(v, cell.s);
  return { text: s, quote: false };
}

function encode(text: string, layout: CsvLayout | undefined): Uint8Array {
  if (layout?.latin1 && ![...text].some((ch) => ch.charCodeAt(0) > 255)) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  }
  const body = new TextEncoder().encode(text);
  if (!layout?.bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}

/**
 * Write one sheet as CSV (or TSV with delim '\t'). Without `delim`, a sheet read from a CSV keeps its own separator.
 * Rows and columns that hold nothing at the end are left out (formatting alone doesn't make a row).
 */
export function writeCsv(wb: Workbook, sheetIndex: number, delim?: string): Uint8Array {
  const sheet = wb.sheets[sheetIndex];
  const layout = sheet.csv;
  const d = delim || (layout && layout.delim !== '\t' ? layout.delim : ',');
  const calc = new Calc(wb);
  let maxR = 0;
  let maxC = 0;
  for (const k in sheet.cells) {
    const c = sheet.cells[k];
    if (c.v === undefined && c.f === undefined && c.orig === undefined) continue;
    const p = parseKey(k);
    maxR = Math.max(maxR, p.r + 1);
    maxC = Math.max(maxC, p.c + 1);
  }
  const grid: { text: string; quote: boolean }[][] = [];
  for (let r = 0; r < maxR; r++) {
    const row: { text: string; quote: boolean }[] = [];
    for (let c = 0; c < maxC; c++) row.push(fieldText(calc, sheet, r, c));
    grid.push(row);
  }
  // Drop rows and columns at the end that came out empty (a formula giving "" or a cleared cell).
  const filled = (f: { text: string; quote: boolean }) => f.text !== '' || f.quote;
  while (grid.length && !grid[grid.length - 1].some(filled)) grid.pop();
  const lastInRow = grid.map((row) => {
    let n = row.length;
    while (n && !filled(row[n - 1])) n--;
    return n;
  });
  const used = Math.max(0, ...lastInRow);
  const widths = layout?.widths || [];
  const uniform = !layout || widths.every((w) => w === widths[0]);
  const uniformW = Math.max(used, uniform && widths.length ? widths[0] : 0);
  const quoteIfNeeded = (f: { text: string; quote: boolean }) =>
    f.quote || f.text.includes(d) || f.text.includes('"') || f.text.includes('\n') || f.text.includes('\r') ? `"${f.text.replace(/"/g, '""')}"` : f.text;
  const lines = grid.map((row, r) => {
    const w = uniform ? uniformW : Math.max(lastInRow[r], widths[r] ?? 0);
    const out: string[] = [];
    for (let c = 0; c < w; c++) out.push(quoteIfNeeded(row[c] || { text: '', quote: false }));
    return out.join(d);
  });
  for (let i = 0; i < (layout?.trailingBlank || 0); i++) lines.push(uniform && uniformW > 1 ? new Array(uniformW).fill('').join(d) : '');
  const eol = layout?.eol || '\r\n';
  const finalEol = layout ? layout.finalEol : true;
  const text = lines.join(eol) + (finalEol && lines.length ? eol : '');
  return encode(text, layout);
}

/** Visual formatting a CSV file can't hold (number formats can: they are written as the text shown). */
const LOOK_KEYS: (keyof CellStyle)[] = ['b', 'i', 'u', 's', 'color', 'bg', 'align', 'valign', 'wrap', 'size', 'font', 'bt', 'bb', 'bl', 'br'];

/** What saving this workbook as CSV would drop, in a few words, or null when nothing would be lost. */
export function csvLosses(wb: Workbook, sheetIndex: number): string | null {
  const lost: string[] = [];
  const sheet = wb.sheets[sheetIndex];
  const cells = Object.values(sheet.cells);
  if (cells.some((c) => c.s && LOOK_KEYS.some((k) => c.s![k] !== undefined && c.s![k] !== false))) lost.push('formatting');
  if (cells.some((c) => c.f !== undefined)) lost.push('formulas');
  if (wb.sheets.length > 1) lost.push('other sheets');
  if (sheet.charts?.length) lost.push('charts');
  if (!lost.length) return null;
  return lost.length === 1 ? lost[0] : `${lost.slice(0, -1).join(', ')} and ${lost[lost.length - 1]}`;
}

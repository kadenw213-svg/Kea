import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { Workbook, Sheet, Cell, CellStyle, NumFmt, newSheet, key, parseKey, parseInput, Calc, formatValue, usedRange, DEFAULT_COL_W } from './model';
import { FormulaError, colIndex, parseAddr } from './formula';
import { extOf } from '../../lib/fileTypes';
import { bytesToText, textToBytes } from '../../lib/util';

// ---------- Format mapping ----------
function fmtFromCode(code: string | undefined): Partial<CellStyle> {
  if (!code || code === 'General') return {};
  const c = code.toLowerCase();
  const dpMatch = code.match(/\.(0+)/);
  const dp = dpMatch ? dpMatch[1].length : 0;
  if (c === '@') return { fmt: 'text' };
  if (/[ymd]/.test(c.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '')) && !/0/.test(c)) {
    return { fmt: /h/.test(c) ? 'datetime' : 'date', numFmt: code };
  }
  if (c.includes('%')) return { fmt: 'percent', dp, numFmt: code };
  if (/[$€£¥]/.test(code)) return { fmt: 'currency', dp, numFmt: code };
  if (/0/.test(c)) return { fmt: dp || c.includes(',') ? 'number' : 'general', dp, numFmt: code };
  return { numFmt: code };
}

function codeFromFmt(s: CellStyle | undefined): string | undefined {
  if (!s) return undefined;
  const zeros = (n: number) => (n > 0 ? '.' + '0'.repeat(n) : '');
  switch (s.fmt as NumFmt | undefined) {
    case 'number':
      return `#,##0${zeros(s.dp ?? 2)}`;
    case 'currency':
      return s.numFmt && /[$€£¥]/.test(s.numFmt) && s.dp === undefined ? s.numFmt : `"$"#,##0${zeros(s.dp ?? 2)}`;
    case 'percent':
      return `0${zeros(s.dp ?? 0)}%`;
    case 'date':
      return s.numFmt && /[ymd]/i.test(s.numFmt) ? s.numFmt : 'm/d/yyyy';
    case 'datetime':
      return 'm/d/yyyy h:mm';
    case 'text':
      return '@';
    default:
      if (s.dp !== undefined) return `0${zeros(s.dp)}`;
      return s.numFmt;
  }
}

const argbToHex = (argb?: string) => (argb && /^[0-9a-f]{8}$/i.test(argb) ? '#' + argb.slice(2).toLowerCase() : argb && /^[0-9a-f]{6}$/i.test(argb) ? '#' + argb.toLowerCase() : undefined);
const hexToArgb = (hex: string) => 'FF' + hex.replace('#', '').toUpperCase().padStart(6, '0').slice(0, 6);

const excelDateToSerial = (d: Date) => d.getTime() / 86400000 + 25569;

// ---------- Reading ----------
export async function readWorkbook(name: string, bytes: Uint8Array): Promise<Workbook> {
  const ext = extOf(name);
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return { sheets: [readCsv(bytesToText(bytes), ext === 'tsv' ? '\t' : undefined, name)] };
  if (ext === 'xlsx' || ext === 'xlsm') {
    try {
      return await readXlsx(bytes);
    } catch (err) {
      console.warn('ExcelJS failed, falling back to SheetJS', err);
    }
  }
  return readWithSheetJs(bytes);
}

async function readXlsx(bytes: Uint8Array): Promise<Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const sheets: Sheet[] = [];
  wb.eachSheet((ws) => {
    const sheet = newSheet(ws.name);
    ws.eachRow({ includeEmpty: false }, (row, rn) => {
      if (row.height && Math.abs(row.height - 15) > 0.5) sheet.rowH[rn - 1] = Math.round((row.height * 4) / 3);
      row.eachCell({ includeEmpty: false }, (cell, cn) => {
        const c: Cell = {};
        const v: any = cell.value;
        switch (cell.type) {
          case ExcelJS.ValueType.Number:
            c.v = v;
            break;
          case ExcelJS.ValueType.String:
          case ExcelJS.ValueType.SharedString:
            c.v = String(v);
            break;
          case ExcelJS.ValueType.Boolean:
            c.v = !!v;
            break;
          case ExcelJS.ValueType.Date:
            c.v = excelDateToSerial(v);
            break;
          case ExcelJS.ValueType.RichText:
            c.v = (v.richText || []).map((t: any) => t.text).join('');
            break;
          case ExcelJS.ValueType.Hyperlink:
            c.v = typeof v.text === 'string' ? v.text : v.text?.richText?.map((t: any) => t.text).join('') || v.hyperlink;
            break;
          case ExcelJS.ValueType.Formula: {
            const f = (cell as any).formula || v.formula;
            if (f) c.f = String(f).replace(/^=/, '');
            else {
              const res = v.result;
              c.v = res instanceof Date ? excelDateToSerial(res) : typeof res === 'object' ? null : res;
            }
            break;
          }
          case ExcelJS.ValueType.Error:
            c.v = v?.error || '#N/A';
            break;
          case ExcelJS.ValueType.Merge:
            return;
        }
        const s: CellStyle = {};
        const font: any = cell.font;
        if (font) {
          if (font.bold) s.b = true;
          if (font.italic) s.i = true;
          if (font.underline) s.u = true;
          if (font.strike) s.s = true;
          const col = argbToHex(font.color?.argb);
          if (col && col !== '#000000') s.color = col;
          if (font.size && font.size !== 11) s.size = font.size;
        }
        const fill: any = cell.fill;
        if (fill?.type === 'pattern' && fill.pattern === 'solid') {
          const bg = argbToHex(fill.fgColor?.argb);
          if (bg && bg !== '#ffffff') s.bg = bg;
        }
        const al: any = cell.alignment;
        if (al?.horizontal === 'center' || al?.horizontal === 'right' || al?.horizontal === 'left') s.align = al.horizontal;
        if (al?.vertical === 'top' || al?.vertical === 'middle') s.valign = al.vertical;
        if (al?.wrapText) s.wrap = true;
        Object.assign(s, fmtFromCode(cell.numFmt));
        if (cell.type === ExcelJS.ValueType.Date && !s.fmt) s.fmt = 'date';
        if (Object.keys(s).length) c.s = s;
        if (c.v !== undefined || c.f !== undefined || c.s) sheet.cells[key(rn - 1, cn - 1)] = c;
      });
    });
    (ws.columns || []).forEach((col: any, i: number) => {
      if (col?.width && Math.abs(col.width - 8.43) > 0.3) sheet.colW[i] = Math.max(24, Math.round(col.width * 7 + 5));
    });
    const view: any = ws.views?.[0];
    if (view?.state === 'frozen') sheet.freeze = { rows: view.ySplit || 0, cols: view.xSplit || 0 };
    const merges: string[] = (ws as any).model?.merges || [];
    if (merges.length) {
      sheet.merges = merges
        .map((m) => {
          const [a, b] = m.split(':').map(parseAddr);
          return a && b ? { r1: a.r, c1: a.c, r2: b.r, c2: b.c } : null;
        })
        .filter(Boolean) as any;
    }
    sheets.push(sheet);
  });
  if (!sheets.length) sheets.push(newSheet('Sheet1'));
  return { sheets };
}

function readWithSheetJs(bytes: Uint8Array): Workbook {
  const wb = XLSX.read(bytes, { type: 'array', cellFormula: true, cellNF: true, cellDates: false });
  const sheets: Sheet[] = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const sheet = newSheet(name);
    for (const a in ws) {
      if (a[0] === '!') continue;
      const p = parseAddr(a);
      if (!p) continue;
      const src: any = ws[a];
      const c: Cell = {};
      if (src.f) c.f = src.f;
      else if (src.t === 'n') c.v = src.v;
      else if (src.t === 'b') c.v = !!src.v;
      else if (src.t === 'e') c.v = src.w || '#N/A';
      else if (src.t === 'd') c.v = excelDateToSerial(new Date(src.v));
      else if (src.v !== undefined && src.v !== '') c.v = String(src.v);
      const fmt = fmtFromCode(src.z);
      if (Object.keys(fmt).length) c.s = fmt;
      if (c.v !== undefined || c.f !== undefined) sheet.cells[key(p.r, p.c)] = c;
    }
    (ws['!cols'] || []).forEach((col: any, i: number) => {
      if (col?.wpx) sheet.colW[i] = Math.round(col.wpx);
      else if (col?.wch) sheet.colW[i] = Math.round(col.wch * 7 + 5);
    });
    (ws['!merges'] || []).forEach((m: any) => {
      (sheet.merges ||= []).push({ r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c });
    });
    return sheet;
  });
  return { sheets: sheets.length ? sheets : [newSheet('Sheet1')] };
}

export function parseCsv(text: string, delim?: string): string[][] {
  if (!delim) {
    const first = text.slice(0, 2000).split(/\r?\n/)[0] || '';
    const counts = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length] as const);
    delim = counts.sort((a, b) => b[1] - a[1])[0][1] > 1 ? counts[0][0] : ',';
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += ch;
    } else if (ch === '"' && field === '') q = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function readCsv(text: string, delim: string | undefined, name: string): Sheet {
  const sheet = newSheet(name.replace(/\.[^.]+$/, '').slice(0, 31) || 'Sheet1');
  parseCsv(text, delim).forEach((row, r) =>
    row.forEach((raw, c) => {
      if (raw === '') return;
      // Keep leading-zero values (zip codes, IDs) as text; don't treat "=..." in data as formulas.
      if (/^0\d+$/.test(raw.trim()) || raw.startsWith('=')) {
        sheet.cells[key(r, c)] = { v: raw };
        return;
      }
      const parsed = parseInput(raw);
      sheet.cells[key(r, c)] = parsed.fmt ? { ...parsed.cell, s: parsed.fmt as CellStyle } : parsed.cell;
    })
  );
  return sheet;
}

// ---------- Writing ----------
export async function writeXlsx(wb: Workbook): Promise<Uint8Array> {
  const calc = new Calc(wb);
  const out = new ExcelJS.Workbook();
  out.creator = 'Slate Office';
  out.created = new Date();
  for (const sheet of wb.sheets) {
    const ws = out.addWorksheet(sheet.name.slice(0, 31), {
      views: sheet.freeze.rows || sheet.freeze.cols ? [{ state: 'frozen', xSplit: sheet.freeze.cols, ySplit: sheet.freeze.rows }] : undefined
    });
    for (const k in sheet.cells) {
      const { r, c } = parseKey(k);
      const src = sheet.cells[k];
      const cell = ws.getCell(r + 1, c + 1);
      if (src.f !== undefined) {
        const res = calc.value(sheet, r, c);
        cell.value = { formula: src.f, result: res instanceof FormulaError ? undefined : (res as any) } as any;
      } else if (src.v !== undefined && src.v !== null) {
        cell.value = src.v as any;
      }
      const s = src.s;
      if (!s) continue;
      if (s.b || s.i || s.u || s.s || s.color || s.size || s.font) {
        cell.font = {
          bold: s.b || undefined,
          italic: s.i || undefined,
          underline: s.u || undefined,
          strike: s.s || undefined,
          color: s.color ? { argb: hexToArgb(s.color) } : undefined,
          size: s.size || 11,
          name: s.font || 'Calibri'
        };
      }
      if (s.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: hexToArgb(s.bg) } };
      if (s.align || s.wrap || s.valign) cell.alignment = { horizontal: s.align, vertical: s.valign, wrapText: s.wrap || undefined };
      const code = codeFromFmt(s);
      if (code) cell.numFmt = code;
    }
    for (const c in sheet.colW) ws.getColumn(+c + 1).width = Math.max(1, (sheet.colW[c] - 5) / 7);
    for (const r in sheet.rowH) ws.getRow(+r + 1).height = (sheet.rowH[r] * 3) / 4;
    for (const m of sheet.merges || []) {
      try {
        ws.mergeCells(m.r1 + 1, m.c1 + 1, m.r2 + 1, m.c2 + 1);
      } catch {}
    }
  }
  const buf = await out.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

export function writeCsv(wb: Workbook, sheetIndex: number, delim = ','): Uint8Array {
  const sheet = wb.sheets[sheetIndex];
  const calc = new Calc(wb);
  const { rows, cols } = usedRange(sheet);
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const fields: string[] = [];
    for (let c = 0; c < cols; c++) {
      const cell = sheet.cells[key(r, c)];
      const v = calc.value(sheet, r, c);
      let s = v === null ? '' : typeof v === 'number' && (!cell?.s?.fmt || cell.s.fmt === 'general') ? String(v) : formatValue(v, cell?.s);
      if (s.includes(delim) || s.includes('"') || s.includes('\n') || s.includes('\r')) s = `"${s.replace(/"/g, '""')}"`;
      fields.push(s);
    }
    lines.push(fields.join(delim));
  }
  return textToBytes(lines.join('\r\n') + '\r\n');
}

export function writeOds(wb: Workbook): Uint8Array {
  const out = XLSX.utils.book_new();
  for (const sheet of wb.sheets) {
    const ws: any = {};
    const { rows, cols } = usedRange(sheet);
    for (const k in sheet.cells) {
      const { r, c } = parseKey(k);
      const src = sheet.cells[k];
      const a = XLSX.utils.encode_cell({ r, c });
      if (src.f !== undefined) ws[a] = { t: 'n', f: src.f };
      else if (typeof src.v === 'number') ws[a] = { t: 'n', v: src.v, z: codeFromFmt(src.s) };
      else if (typeof src.v === 'boolean') ws[a] = { t: 'b', v: src.v };
      else if (src.v !== undefined && src.v !== null) ws[a] = { t: 's', v: String(src.v) };
    }
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, rows - 1), c: Math.max(0, cols - 1) } });
    ws['!cols'] = Array.from({ length: cols }, (_, i) => ({ wpx: sheet.colW[i] || DEFAULT_COL_W }));
    XLSX.utils.book_append_sheet(out, ws, sheet.name.slice(0, 31));
  }
  return new Uint8Array(XLSX.write(out, { type: 'array', bookType: 'ods' }));
}

export { colIndex };

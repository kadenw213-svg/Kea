import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { Workbook, Sheet, Cell, CellStyle, NumFmt, newSheet, key, parseKey, parseInput, Calc, formatValue, usedRange, DEFAULT_COL_W, DEFAULT_ROW_H, Border, Range, CondRule } from './model';
import { FormulaError, colIndex, parseAddr, addr } from './formula';
import { chartData, chartSvg, chartPng } from './chart';

/** Kea-only sheet features (live charts, rule details) live in a very hidden sheet with this name. */
const DATA_SHEET = '_kea_data';
const rangeRef = (g: Range) => `${addr(g.r1, g.c1)}:${addr(g.r2, g.c2)}`;
const BORDER_STYLES = ['thin', 'medium', 'thick', 'dashed', 'dotted', 'double'];
const readBorder = (b: any): Border | undefined => (b?.style ? { style: (BORDER_STYLES.includes(b.style) ? b.style : 'thin') as Border['style'], color: argbToHex(b.color?.argb) } : undefined);
const writeBorder = (b?: Border) => (b ? { style: b.style as any, color: b.color ? { argb: hexToArgb(b.color) } : undefined } : undefined);
import { extOf } from '../../lib/fileTypes';
import { bytesToText, textToBytes } from '../../lib/util';
import { LEGACY } from '../../lib/legacy';

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
  // Kea's own data for each sheet, if the file was saved by Kea.
  let extra: Record<string, any> = {};
  const dataWs = wb.getWorksheet(DATA_SHEET) || wb.getWorksheet(LEGACY.sheetData);
  if (dataWs) {
    let json = '';
    dataWs.eachRow((row) => (json += String(row.getCell(1).value ?? '')));
    try {
      extra = JSON.parse(json).sheets || {};
    } catch {}
  }
  wb.eachSheet((ws) => {
    if (ws.name === DATA_SHEET || ws.name === LEGACY.sheetData) return;
    const sheet = newSheet(ws.name);
    const validations: NonNullable<Sheet['validations']> = [];
    ws.eachRow({ includeEmpty: true }, (row, rn) => {
      if ((row as any).hidden) (sheet.hiddenRows ||= {})[rn - 1] = true;
    });
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
        const bd: any = cell.border;
        if (bd) {
          const t = readBorder(bd.top),
            b = readBorder(bd.bottom),
            l = readBorder(bd.left),
            r = readBorder(bd.right);
          if (t) s.bt = t;
          if (b) s.bb = b;
          if (l) s.bl = l;
          if (r) s.br = r;
        }
        // Dropdown lists from Excel (one rule per cell; merged with neighbours below).
        const dv: any = (cell as any).dataValidation;
        if (dv?.type === 'list' && dv.formulae?.[0]) {
          const f = String(dv.formulae[0]);
          const values = f.startsWith('"') ? f.replace(/^"|"$/g, '').split(',').map((x: string) => x.trim()) : undefined;
          const last = validations[validations.length - 1];
          const same = last && JSON.stringify(last.values) === JSON.stringify(values) && last.source === (values ? undefined : f) && last.range.c1 === cn - 1 && last.range.r2 === rn - 2;
          if (same) last.range.r2 = rn - 1;
          else validations.push({ id: `x${rn}_${cn}`, range: { r1: rn - 1, c1: cn - 1, r2: rn - 1, c2: cn - 1 }, type: 'list', values, source: values ? undefined : f.replace(/\$/g, ''), strict: dv.errorStyle !== 'warning' && dv.errorStyle !== 'information' });
        }
        if (Object.keys(s).length) c.s = s;
        if (c.v !== undefined || c.f !== undefined || c.s) sheet.cells[key(rn - 1, cn - 1)] = c;
      });
    });
    (ws.columns || []).forEach((col: any, i: number) => {
      if (col?.width && Math.abs(col.width - 8.43) > 0.3) sheet.colW[i] = Math.max(24, Math.round(col.width * 7 + 5));
    });
    const view: any = ws.views?.[0];
    if (view?.state === 'frozen') sheet.freeze = { rows: view.ySplit || 0, cols: view.xSplit || 0 };
    if (view?.showGridLines === false) sheet.gridlines = false;
    if (validations.length) sheet.validations = validations;
    const af: any = (ws as any).autoFilter;
    const afRef = typeof af === 'string' ? af : af?.from && af?.to ? `${typeof af.from === 'string' ? af.from : addr(af.from.row - 1, af.from.column - 1)}:${typeof af.to === 'string' ? af.to : addr(af.to.row - 1, af.to.column - 1)}` : null;
    if (afRef) {
      const [a, b] = afRef.replace(/\$/g, '').split(':').map(parseAddr);
      if (a && b) sheet.filter = { range: { r1: a.r, c1: a.c, r2: b.r, c2: b.c }, cols: {} };
    }
    // Conditional formatting written by Excel (the common rule types).
    const cfs: any[] = (ws as any).conditionalFormattings || [];
    const rules: CondRule[] = [];
    for (const cfm of cfs) {
      const [a, b] = String(cfm.ref || '').split(' ')[0].replace(/\$/g, '').split(':').map(parseAddr);
      if (!a) continue;
      const range = { r1: a.r, c1: a.c, r2: (b || a).r, c2: (b || a).c };
      for (const r of cfm.rules || []) {
        const style = { bg: argbToHex(r.style?.fill?.bgColor?.argb || r.style?.fill?.fgColor?.argb), color: argbToHex(r.style?.font?.color?.argb), b: r.style?.font?.bold || undefined };
        const id = `x${rules.length}`;
        if (r.type === 'cellIs') {
          const op: Record<string, CondRule['type']> = { greaterThan: 'gt', lessThan: 'lt', greaterThanOrEqual: 'gte', lessThanOrEqual: 'lte', equal: 'eq', notEqual: 'neq', between: 'between' };
          if (op[r.operator]) rules.push({ id, range, type: op[r.operator], a: String(r.formulae?.[0] ?? '').replace(/^"|"$/g, ''), b: r.formulae?.[1] !== undefined ? String(r.formulae[1]) : undefined, style });
        } else if (r.type === 'colorScale') rules.push({ id, range, type: 'scale', colors: (r.color || []).map((c: any) => argbToHex(c.argb) || '#ffffff') });
        else if (r.type === 'dataBar') rules.push({ id, range, type: 'bars', colors: [argbToHex(r.color?.argb) || '#638ec6'] });
        else if (r.type === 'expression' && r.formulae?.[0]) rules.push({ id, range, type: 'formula', a: String(r.formulae[0]), style });
        else if (r.type === 'top10') rules.push({ id, range, type: r.bottom ? 'bottom' : 'top', n: r.rank || 10, style });
        else if (r.type === 'aboveAverage') rules.push({ id, range, type: r.aboveAverage === false ? 'belowAvg' : 'aboveAvg', style });
        else if (r.type === 'containsText' && r.text) rules.push({ id, range, type: r.operator === 'notContains' ? 'notContains' : 'contains', a: r.text, style });
      }
    }
    if (rules.length) sheet.condRules = rules;
    // Kea's own copy wins: it has live charts and the exact rule settings.
    const x = extra[ws.name];
    if (x) {
      if (x.charts) sheet.charts = x.charts;
      if (x.validations) sheet.validations = x.validations;
      if (x.condRules) sheet.condRules = x.condRules;
      if ('filter' in x) sheet.filter = x.filter;
      if (x.gridlines === false) sheet.gridlines = false;
    }
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
  out.creator = 'Kea';
  out.created = new Date();
  const extra: Record<string, any> = {};
  for (const sheet of wb.sheets) {
    const frozen = sheet.freeze.rows || sheet.freeze.cols;
    const ws = out.addWorksheet(sheet.name.slice(0, 31), {
      views: frozen ? [{ state: 'frozen', xSplit: sheet.freeze.cols, ySplit: sheet.freeze.rows, showGridLines: sheet.gridlines !== false }] : sheet.gridlines === false ? [{ showGridLines: false } as any] : undefined
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
      if (s.bt || s.bb || s.bl || s.br) cell.border = { top: writeBorder(s.bt), bottom: writeBorder(s.bb), left: writeBorder(s.bl), right: writeBorder(s.br) } as any;
    }
    // Hidden rows (filters), the filter range itself, and dropdowns.
    for (const r in sheet.hiddenRows || {}) ws.getRow(+r + 1).hidden = true;
    if (sheet.filter) ws.autoFilter = rangeRef(sheet.filter.range);
    for (const v of sheet.validations || []) {
      const cells = (v.range.r2 - v.range.r1 + 1) * (v.range.c2 - v.range.c1 + 1);
      if (cells > 20000) continue;
      const list = v.type === 'checkbox' ? ['TRUE', 'FALSE'] : v.values;
      const dv: any =
        v.type === 'list' || v.type === 'checkbox'
          ? { type: 'list', allowBlank: true, formulae: [list?.length ? `"${list.join(',').replace(/"/g, '""')}"` : (v.source || '').replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')] }
          : v.type === 'number'
            ? { type: 'decimal', allowBlank: true, operator: v.min != null && v.max != null ? 'between' : v.min != null ? 'greaterThanOrEqual' : 'lessThanOrEqual', formulae: [v.min ?? v.max, ...(v.min != null && v.max != null ? [v.max] : [])] }
            : v.type === 'textLength'
              ? { type: 'textLength', allowBlank: true, operator: 'between', formulae: [v.min ?? 0, v.max ?? 32767] }
              : null;
      if (!dv) continue;
      Object.assign(dv, { showErrorMessage: true, errorStyle: v.strict ? 'stop' : 'warning', showInputMessage: !!v.help, prompt: v.help || undefined });
      for (let r = v.range.r1; r <= v.range.r2; r++) for (let c = v.range.c1; c <= v.range.c2; c++) ws.getCell(r + 1, c + 1).dataValidation = dv;
    }
    // Conditional formatting in Excel's own terms.
    for (const rule of sheet.condRules || []) {
      const ref = rangeRef(rule.range);
      const first = addr(rule.range.r1, rule.range.c1);
      const style = { fill: rule.style?.bg ? { type: 'pattern', pattern: 'solid', bgColor: { argb: hexToArgb(rule.style.bg) } } : undefined, font: rule.style?.color || rule.style?.b ? { color: rule.style?.color ? { argb: hexToArgb(rule.style.color) } : undefined, bold: rule.style?.b || undefined } : undefined };
      const q = (s?: string) => (s === undefined || s === '' || isNaN(Number(s)) ? `"${String(s ?? '').replace(/"/g, '""')}"` : s);
      const op: Record<string, string> = { gt: 'greaterThan', lt: 'lessThan', gte: 'greaterThanOrEqual', lte: 'lessThanOrEqual', eq: 'equal', neq: 'notEqual', between: 'between' };
      let r: any = null;
      if (op[rule.type]) r = { type: 'cellIs', operator: op[rule.type], formulae: rule.type === 'between' ? [q(rule.a), q(rule.b)] : [q(rule.a)], style };
      else if (rule.type === 'scale') {
        const cols = rule.colors?.length ? rule.colors : ['#f8696b', '#ffeb84', '#63be7b'];
        r = { type: 'colorScale', cfvo: cols.length >= 3 ? [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }] : [{ type: 'min' }, { type: 'max' }], color: cols.map((c) => ({ argb: hexToArgb(c) })) };
      } else if (rule.type === 'bars') r = { type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: hexToArgb(rule.colors?.[0] || '#638ec6') } };
      else if (rule.type === 'top' || rule.type === 'bottom') r = { type: 'top10', rank: rule.n || 10, bottom: rule.type === 'bottom', style };
      else if (rule.type === 'aboveAvg' || rule.type === 'belowAvg') r = { type: 'aboveAverage', aboveAverage: rule.type === 'aboveAvg', style };
      else {
        const abs = `$${ref.replace(':', ':$').replace(/([A-Z]+)(\d+)/g, '$1$$$2')}`;
        const expr: Record<string, string> = {
          contains: `ISNUMBER(SEARCH(${q(rule.a)},${first}))`,
          notContains: `NOT(ISNUMBER(SEARCH(${q(rule.a)},${first})))`,
          startsWith: `LEFT(${first},LEN(${q(rule.a)}))=${q(rule.a)}`,
          empty: `LEN(TRIM(${first}))=0`,
          notEmpty: `LEN(TRIM(${first}))>0`,
          dup: `COUNTIF(${abs},${first})>1`,
          unique: `COUNTIF(${abs},${first})=1`,
          formula: rule.a || 'FALSE'
        };
        if (expr[rule.type]) r = { type: 'expression', formulae: [expr[rule.type]], style };
      }
      if (r) {
        try {
          ws.addConditionalFormatting({ ref, rules: [{ priority: 1, ...r }] } as any);
        } catch {}
      }
    }
    // Charts: a picture Excel can show, plus the live chart in Kea's data.
    for (const ch of sheet.charts || []) {
      try {
        const svg = chartSvg(ch, chartData(ch, sheet, calc), ch.w, ch.h, 'light');
        const png = await chartPng(svg, ch.w, ch.h);
        const id = out.addImage({ buffer: png as any, extension: 'png' });
        let col = 0,
          x = 0;
        while (x + (sheet.colW[col] ?? DEFAULT_COL_W) <= ch.x) x += sheet.colW[col++] ?? DEFAULT_COL_W;
        let row = 0,
          y = 0;
        const rh = (r: number) => (sheet.hiddenRows?.[r] ? 0 : sheet.rowH[r] ?? DEFAULT_ROW_H);
        while (row < 1048575 && y + rh(row) <= ch.y) y += rh(row++);
        ws.addImage(id, { tl: { col: col + (ch.x - x) / (sheet.colW[col] ?? DEFAULT_COL_W), row: row + (ch.y - y) / (sheet.rowH[row] ?? DEFAULT_ROW_H) } as any, ext: { width: ch.w, height: ch.h } });
      } catch (err) {
        console.warn('chart image', (err as any)?.name, (err as any)?.message, err);
      }
    }
    if (sheet.charts?.length || sheet.validations?.length || sheet.condRules?.length || sheet.filter || sheet.gridlines === false) {
      extra[sheet.name.slice(0, 31)] = { charts: sheet.charts, validations: sheet.validations, condRules: sheet.condRules, filter: sheet.filter ?? null, gridlines: sheet.gridlines };
    }
    for (const c in sheet.colW) ws.getColumn(+c + 1).width = Math.max(1, (sheet.colW[c] - 5) / 7);
    for (const r in sheet.rowH) ws.getRow(+r + 1).height = (sheet.rowH[r] * 3) / 4;
    for (const m of sheet.merges || []) {
      try {
        ws.mergeCells(m.r1 + 1, m.c1 + 1, m.r2 + 1, m.c2 + 1);
      } catch {}
    }
  }
  if (Object.keys(extra).length) {
    const ds = out.addWorksheet(DATA_SHEET);
    ds.state = 'veryHidden';
    const json = JSON.stringify({ v: 1, sheets: extra });
    // Cells hold at most 32,767 characters, so long data is split across rows.
    for (let i = 0, row = 1; i < json.length; i += 30000, row++) ds.getCell(row, 1).value = json.slice(i, i + 30000);
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

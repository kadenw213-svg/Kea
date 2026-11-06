/**
 * Spreadsheet formula engine: tokenizer, parser and evaluator with Excel-style
 * semantics for the common function set. Values are numbers, strings,
 * booleans, null (empty) or FormulaError.
 */

export class FormulaError {
  constructor(public code: string) {}
  toString() {
    return this.code;
  }
}
export const ERR = {
  DIV0: new FormulaError('#DIV/0!'),
  VALUE: new FormulaError('#VALUE!'),
  REF: new FormulaError('#REF!'),
  NAME: new FormulaError('#NAME?'),
  NA: new FormulaError('#N/A'),
  NUM: new FormulaError('#NUM!'),
  CIRC: new FormulaError('#CIRC!'),
  CALC: new FormulaError('#CALC!')
};

export type Scalar = number | string | boolean | null | FormulaError;
export type Value = Scalar | Scalar[][];

// ---------- Cell addressing ----------
export function colName(c: number): string {
  let s = '';
  c++;
  while (c > 0) {
    const m = (c - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s;
}
export function colIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export const addr = (r: number, c: number) => `${colName(c)}${r + 1}`;
export function parseAddr(a: string): { r: number; c: number } | null {
  const m = a.replace(/\$/g, '').match(/^([A-Za-z]{1,3})(\d+)$/);
  if (!m) return null;
  return { r: parseInt(m[2], 10) - 1, c: colIndex(m[1]) };
}

// ---------- Tokenizer ----------
export type Token =
  | { t: 'num'; v: number; s: string }
  | { t: 'str'; v: string; s: string }
  | { t: 'bool'; v: boolean; s: string }
  | { t: 'ref'; sheet?: string; c1: number; r1: number; c2?: number; r2?: number; abs: [boolean, boolean, boolean, boolean]; s: string; whole?: 'col' | 'row' }
  | { t: 'func'; v: string; s: string }
  | { t: 'op'; v: string; s: string }
  | { t: 'paren'; v: '(' | ')'; s: string }
  | { t: 'comma'; s: string }
  | { t: 'err'; v: string; s: string }
  | { t: 'ws'; s: string }
  | { t: 'name'; v: string; s: string };

const CELL = String.raw`(\$?)([A-Za-z]{1,3})(\$?)(\d+)`;
const SHEET = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!`;
const RE_RANGE = new RegExp(`^(?:${SHEET})?${CELL}(?::${CELL})?`);
const RE_COLRANGE = new RegExp(String.raw`^(?:${SHEET})?(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![\w(])`);

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const ch = src[i];
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\s+/))) {
      out.push({ t: 'ws', s: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1,
        v = '';
      while (j < src.length) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            v += '"';
            j += 2;
            continue;
          }
          break;
        }
        v += src[j++];
      }
      out.push({ t: 'str', v, s: src.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    if ((m = rest.match(/^#(DIV\/0!|VALUE!|REF!|NAME\?|N\/A|NUM!|NULL!)/i))) {
      out.push({ t: 'err', v: m[0].toUpperCase(), s: m[0] });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/))) {
      out.push({ t: 'num', v: parseFloat(m[0]), s: m[0] });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(RE_RANGE)) && !/^[\w(]/.test(rest.slice(m[0].length))) {
      const sheet = m[1] ? m[1].replace(/''/g, "'") : m[2];
      const tok: any = { t: 'ref', sheet, c1: colIndex(m[4]), r1: parseInt(m[6], 10) - 1, abs: [!!m[3], !!m[5], !!m[7], !!m[9]], s: m[0] };
      if (m[8]) {
        tok.c2 = colIndex(m[8]);
        tok.r2 = parseInt(m[10], 10) - 1;
      }
      out.push(tok);
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(RE_COLRANGE))) {
      const sheet = m[1] ? m[1].replace(/''/g, "'") : m[2];
      out.push({ t: 'ref', sheet, c1: colIndex(m[4]), r1: 0, c2: colIndex(m[6]), r2: 1048575, abs: [!!m[3], true, !!m[5], true], s: m[0], whole: 'col' });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^([A-Za-z_][\w.]*)\s*\(/))) {
      out.push({ t: 'func', v: m[1].toUpperCase(), s: m[1] });
      i += m[1].length;
      continue;
    }
    if ((m = rest.match(/^(TRUE|FALSE)(?![\w(])/i))) {
      out.push({ t: 'bool', v: m[1].toUpperCase() === 'TRUE', s: m[0] });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^[A-Za-z_][\w.]*/))) {
      out.push({ t: 'name', v: m[0], s: m[0] });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^(<>|<=|>=|[-+*/^&=<>%])/))) {
      out.push({ t: 'op', v: m[0], s: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === '(' || ch === ')') {
      out.push({ t: 'paren', v: ch, s: ch });
      i++;
      continue;
    }
    if (ch === ',' || ch === ';') {
      out.push({ t: 'comma', s: ch });
      i++;
      continue;
    }
    throw ERR.NAME;
  }
  return out;
}

// ---------- Parser ----------
type Node =
  | { k: 'lit'; v: Scalar }
  | { k: 'ref'; tok: Extract<Token, { t: 'ref' }> }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'pct'; a: Node }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'name'; v: string };

const PREC: Record<string, number> = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };

export function parse(src: string): Node {
  const toks = tokenize(src).filter((t) => t.t !== 'ws');
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];

  const primary = (): Node => {
    const t = next();
    if (!t) throw ERR.VALUE;
    switch (t.t) {
      case 'num':
        return { k: 'lit', v: t.v };
      case 'str':
        return { k: 'lit', v: t.v };
      case 'bool':
        return { k: 'lit', v: t.v };
      case 'err':
        return { k: 'lit', v: new FormulaError(t.v) };
      case 'ref':
        return { k: 'ref', tok: t };
      case 'name':
        return { k: 'name', v: t.v };
      case 'func': {
        next(); // (
        const args: Node[] = [];
        if (peek()?.t === 'paren' && (peek() as any).v === ')') {
          next();
          return { k: 'call', name: t.v, args };
        }
        while (true) {
          if (peek()?.t === 'comma' || (peek()?.t === 'paren' && (peek() as any).v === ')')) args.push({ k: 'lit', v: null });
          else args.push(expr(0));
          const sep = next();
          if (!sep) throw ERR.VALUE;
          if (sep.t === 'paren' && sep.v === ')') break;
          if (sep.t !== 'comma') throw ERR.VALUE;
        }
        return { k: 'call', name: t.v, args };
      }
      case 'paren':
        if (t.v === '(') {
          const e = expr(0);
          const close = next();
          if (!close || close.t !== 'paren' || close.v !== ')') throw ERR.VALUE;
          return e;
        }
        throw ERR.VALUE;
      case 'op':
        if (t.v === '-' || t.v === '+') return { k: 'un', op: t.v, a: unaryOperand() };
        throw ERR.VALUE;
      default:
        throw ERR.VALUE;
    }
  };
  // Unary minus binds tighter than ^ in Excel (=-2^2 is 4).
  const unaryOperand = (): Node => postfix(primary());
  const postfix = (n: Node): Node => {
    while (peek()?.t === 'op' && (peek() as any).v === '%') {
      next();
      n = { k: 'pct', a: n };
    }
    return n;
  };
  const expr = (minPrec: number): Node => {
    let left = postfix(primary());
    while (true) {
      const t = peek();
      if (!t || t.t !== 'op' || PREC[t.v] === undefined || PREC[t.v] < minPrec) break;
      next();
      const prec = PREC[t.v];
      const right = expr(prec + 1); // all binary operators are left-associative in Excel
      left = { k: 'bin', op: t.v, a: left, b: right };
    }
    return left;
  };
  const root = expr(0);
  if (p < toks.length) throw ERR.VALUE;
  return root;
}

// ---------- Evaluation ----------
export interface EvalContext {
  /** Value of a single cell (evaluating formulas as needed). */
  cell(sheet: string | undefined, r: number, c: number): Scalar;
  /** Bounds of used data, to clip whole-column references. */
  usedRows(sheet: string | undefined): number;
  sheetExists(sheet: string): boolean;
}

const isErr = (v: any): v is FormulaError => v instanceof FormulaError;

export function toNum(v: Scalar): number | FormulaError {
  if (isErr(v)) return v;
  if (v === null || v === '') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(String(v).replace(/,/g, '').trim());
  if (String(v).trim() !== '' && !isNaN(n)) return n;
  const pct = String(v).trim().match(/^(-?[\d.]+)%$/);
  if (pct) return parseFloat(pct[1]) / 100;
  return ERR.VALUE;
}
export function toStr(v: Scalar): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return formatGeneral(v);
  return String(v);
}
export function toBool(v: Scalar): boolean | FormulaError {
  if (isErr(v)) return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null || v === '') return false;
  const s = String(v).toUpperCase();
  if (s === 'TRUE') return true;
  if (s === 'FALSE') return false;
  return ERR.VALUE;
}

export function formatGeneral(n: number): string {
  if (!isFinite(n)) return '#NUM!';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-9 || abs >= 1e15)) return n.toExponential(5).replace(/\.?0+e/, 'e');
  return String(parseFloat(n.toPrecision(12)));
}

function evalNode(n: Node, ctx: EvalContext): Value {
  switch (n.k) {
    case 'lit':
      return n.v;
    case 'name':
      return ERR.NAME;
    case 'ref': {
      const t = n.tok;
      if (t.sheet && !ctx.sheetExists(t.sheet)) return ERR.REF;
      if (t.c2 === undefined) return ctx.cell(t.sheet, t.r1, t.c1);
      const r1 = Math.min(t.r1, t.r2!),
        c1 = Math.min(t.c1, t.c2);
      let r2 = Math.max(t.r1, t.r2!);
      const c2 = Math.max(t.c1, t.c2);
      if (t.whole === 'col') r2 = Math.min(r2, ctx.usedRows(t.sheet) - 1);
      const out: Scalar[][] = [];
      for (let r = r1; r <= r2; r++) {
        const row: Scalar[] = [];
        for (let c = c1; c <= c2; c++) row.push(ctx.cell(t.sheet, r, c));
        out.push(row);
      }
      return out;
    }
    case 'un': {
      const v = scalar(evalNode(n.a, ctx));
      const x = toNum(v);
      if (isErr(x)) return x;
      return n.op === '-' ? -x : x;
    }
    case 'pct': {
      const x = toNum(scalar(evalNode(n.a, ctx)));
      return isErr(x) ? x : x / 100;
    }
    case 'bin': {
      const av = evalNode(n.a, ctx);
      const bv = evalNode(n.b, ctx);
      if (Array.isArray(av) || Array.isArray(bv)) {
        const A = asGrid(av);
        const B = asGrid(bv);
        const rows = Math.max(A.length, B.length);
        const cols = Math.max(A[0]?.length || 1, B[0]?.length || 1);
        const pick = (g: Scalar[][], r: number, c: number) => (g.length === 1 ? (g[0].length === 1 ? g[0][0] : g[0][c]) : g[r]?.length === 1 ? g[r][0] : g[r]?.[c]) ?? null;
        const out: Scalar[][] = [];
        for (let r = 0; r < rows; r++) {
          const row: Scalar[] = [];
          for (let c = 0; c < cols; c++) row.push(binOp(n.op, pick(A, r, c), pick(B, r, c)));
          out.push(row);
        }
        return out;
      }
      return binOp(n.op, av as Scalar, bv as Scalar);
    }
    case 'call': {
      const fn = FUNCS[n.name];
      if (!fn) return ERR.NAME;
      return fn(n.args, ctx);
    }
  }
}

function binOp(op: string, a: Scalar, b: Scalar): Scalar {
  {
    {
      if (isErr(a)) return a;
      if (isErr(b)) return b;
      if (op === '&') return toStr(a) + toStr(b);
      if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
        const c = compare(a, b);
        switch (op) {
          case '=':
            return c === 0;
          case '<>':
            return c !== 0;
          case '<':
            return c < 0;
          case '>':
            return c > 0;
          case '<=':
            return c <= 0;
          default:
            return c >= 0;
        }
      }
      const x = toNum(a),
        y = toNum(b);
      if (isErr(x)) return x;
      if (isErr(y)) return y;
      switch (op) {
        case '+':
          return x + y;
        case '-':
          return x - y;
        case '*':
          return x * y;
        case '/':
          return y === 0 ? ERR.DIV0 : x / y;
        case '^': {
          const r = Math.pow(x, y);
          return isFinite(r) ? r : ERR.NUM;
        }
      }
      return ERR.VALUE;
    }
  }
}

/** Excel ordering: numbers < text < booleans; text compares case-insensitively. */
export function compare(a: Scalar, b: Scalar): number {
  const rank = (v: Scalar) => (v === null ? -1 : typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
  if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const ra = rank(a),
    rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'string') return a.toLowerCase().localeCompare(String(b).toLowerCase());
  return (a as any) < (b as any) ? -1 : (a as any) > (b as any) ? 1 : 0;
}

function scalar(v: Value): Scalar {
  if (Array.isArray(v)) return v[0]?.[0] ?? null;
  return v;
}

/** Evaluate keeping array results (used for formulas that spill into neighbouring cells). */
export function evaluateRaw(formula: string, ctx: EvalContext): Value {
  try {
    return evalNode(parse(formula), ctx);
  } catch (e) {
    return e instanceof FormulaError ? e : ERR.VALUE;
  }
}

export function evaluate(formula: string, ctx: EvalContext): Scalar {
  try {
    const v = evalNode(parse(formula), ctx);
    const s = scalar(v);
    if (typeof s === 'number' && !isFinite(s)) return ERR.NUM;
    return s === null ? 0 : s;
  } catch (e) {
    return e instanceof FormulaError ? e : ERR.VALUE;
  }
}

// ---------- Function library ----------
type Fn = (args: Node[], ctx: EvalContext) => Value;

const flatten = (vals: Value[]): Scalar[] => vals.flatMap((v) => (Array.isArray(v) ? v.flat() : [v]));
const evalArgs = (args: Node[], ctx: EvalContext) => args.map((a) => evalNode(a, ctx));

/** Numbers from arguments: direct scalars are coerced, values inside ranges must already be numbers. */
function numbers(args: Node[], ctx: EvalContext): number[] | FormulaError {
  const out: number[] = [];
  for (const a of args) {
    const v = evalNode(a, ctx);
    if (Array.isArray(v)) {
      for (const x of v.flat()) {
        if (isErr(x)) return x;
        if (typeof x === 'number') out.push(x);
      }
    } else {
      if (v === null) continue;
      const n = toNum(v);
      if (isErr(n)) return n;
      out.push(n);
    }
  }
  return out;
}

const numFn =
  (f: (nums: number[]) => number | FormulaError): Fn =>
  (args, ctx) => {
    const n = numbers(args, ctx);
    return isErr(n) ? n : f(n);
  };

const arg = (args: Node[], ctx: EvalContext, i: number): Scalar => (args[i] ? scalar(evalNode(args[i], ctx)) : null);
const argNum = (args: Node[], ctx: EvalContext, i: number, def?: number): number | FormulaError => {
  if (!args[i] && def !== undefined) return def;
  return toNum(arg(args, ctx, i));
};
const argStr = (args: Node[], ctx: EvalContext, i: number): string | FormulaError => {
  const v = arg(args, ctx, i);
  return isErr(v) ? v : toStr(v);
};
const asGrid = (v: Value): Scalar[][] => (Array.isArray(v) ? v : [[v]]);

/** Criteria like ">5", "<>x", "a*" used by SUMIF/COUNTIF. */
function matcher(crit: Scalar): (v: Scalar) => boolean {
  if (typeof crit === 'number' || typeof crit === 'boolean') return (v) => compare(v, crit) === 0;
  const s = toStr(crit);
  const m = s.match(/^(<=|>=|<>|<|>|=)?(.*)$/)!;
  const op = m[1] || '=';
  const rhsRaw = m[2];
  const rhsNum = rhsRaw.trim() !== '' && !isNaN(Number(rhsRaw)) ? Number(rhsRaw) : null;
  const rhs: Scalar = rhsNum !== null ? rhsNum : rhsRaw;
  if ((op === '=' || op === '<>') && typeof rhs === 'string' && /[*?]/.test(rhs)) {
    const re = new RegExp('^' + rhs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return (v) => re.test(toStr(v)) === (op === '=');
  }
  return (v) => {
    if (rhs === '' && op === '=') return v === null || v === '';
    if (typeof rhs === 'number' && typeof v !== 'number') return op === '<>';
    const c = compare(v, rhs);
    switch (op) {
      case '=':
        return c === 0;
      case '<>':
        return c !== 0;
      case '<':
        return c < 0;
      case '>':
        return c > 0;
      case '<=':
        return c <= 0;
      default:
        return c >= 0;
    }
  };
}

// Dates are Excel serial numbers (days since 1899-12-30).
const EPOCH = Date.UTC(1899, 11, 30);
export const dateToSerial = (d: Date) => (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EPOCH) / 86400000 + (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
export const serialToDate = (n: number) => {
  const ms = EPOCH + Math.round(n * 86400000);
  const d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
};

function lookupExact(arr: Scalar[], key: Scalar): number {
  return arr.findIndex((v) => compare(v, key) === 0 && (typeof v === typeof key || v === null || key === null));
}
function lookupApprox(arr: Scalar[], key: Scalar): number {
  let best = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === null) continue;
    if (compare(arr[i], key) <= 0) best = i;
    else break;
  }
  return best;
}

const round = (x: number, d: number, mode: 'round' | 'up' | 'down') => {
  const f = Math.pow(10, d);
  const v = x * f;
  const r = mode === 'round' ? Math.sign(v) * Math.round(Math.abs(v) + 1e-9) : mode === 'up' ? Math.sign(v) * Math.ceil(Math.abs(v) - 1e-9) : Math.sign(v) * Math.floor(Math.abs(v) + 1e-9);
  return r / f;
};

export const FUNCS: Record<string, Fn> = {
  SUM: numFn((n) => n.reduce((a, b) => a + b, 0)),
  AVERAGE: numFn((n) => (n.length ? n.reduce((a, b) => a + b, 0) / n.length : ERR.DIV0)),
  MIN: numFn((n) => (n.length ? Math.min(...n) : 0)),
  MAX: numFn((n) => (n.length ? Math.max(...n) : 0)),
  PRODUCT: numFn((n) => n.reduce((a, b) => a * b, 1)),
  MEDIAN: numFn((n) => {
    if (!n.length) return ERR.NUM;
    const s = [...n].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }),
  STDEV: numFn((n) => {
    if (n.length < 2) return ERR.DIV0;
    const mean = n.reduce((a, b) => a + b, 0) / n.length;
    return Math.sqrt(n.reduce((a, b) => a + (b - mean) ** 2, 0) / (n.length - 1));
  }),
  VAR: numFn((n) => {
    if (n.length < 2) return ERR.DIV0;
    const mean = n.reduce((a, b) => a + b, 0) / n.length;
    return n.reduce((a, b) => a + (b - mean) ** 2, 0) / (n.length - 1);
  }),
  COUNT: (args, ctx) => flatten(evalArgs(args, ctx)).filter((v) => typeof v === 'number').length,
  COUNTA: (args, ctx) => flatten(evalArgs(args, ctx)).filter((v) => v !== null && v !== '').length,
  COUNTBLANK: (args, ctx) => flatten(evalArgs(args, ctx)).filter((v) => v === null || v === '').length,
  ABS: (a, c) => {
    const x = argNum(a, c, 0);
    return isErr(x) ? x : Math.abs(x);
  },
  SQRT: (a, c) => {
    const x = argNum(a, c, 0);
    return isErr(x) ? x : x < 0 ? ERR.NUM : Math.sqrt(x);
  },
  POWER: (a, c) => {
    const x = argNum(a, c, 0),
      y = argNum(a, c, 1);
    return isErr(x) ? x : isErr(y) ? y : Math.pow(x, y);
  },
  EXP: (a, c) => {
    const x = argNum(a, c, 0);
    return isErr(x) ? x : Math.exp(x);
  },
  LN: (a, c) => {
    const x = argNum(a, c, 0);
    return isErr(x) ? x : x <= 0 ? ERR.NUM : Math.log(x);
  },
  LOG10: (a, c) => {
    const x = argNum(a, c, 0);
    return isErr(x) ? x : x <= 0 ? ERR.NUM : Math.log10(x);
  },
  LOG: (a, c) => {
    const x = argNum(a, c, 0),
      b = argNum(a, c, 1, 10);
    return isErr(x) ? x : isErr(b) ? b : x <= 0 ? ERR.NUM : Math.log(x) / Math.log(b);
  },
  MOD: (a, c) => {
    const x = argNum(a, c, 0),
      y = argNum(a, c, 1);
    if (isErr(x)) return x;
    if (isErr(y)) return y;
    return y === 0 ? ERR.DIV0 : x - y * Math.floor(x / y);
  },
  INT: (a, c) => {
    const x = argNum(a, c, 0);
    return isErr(x) ? x : Math.floor(x);
  },
  ROUND: (a, c) => {
    const x = argNum(a, c, 0),
      d = argNum(a, c, 1, 0);
    return isErr(x) ? x : isErr(d) ? d : round(x, d, 'round');
  },
  ROUNDUP: (a, c) => {
    const x = argNum(a, c, 0),
      d = argNum(a, c, 1, 0);
    return isErr(x) ? x : isErr(d) ? d : round(x, d, 'up');
  },
  ROUNDDOWN: (a, c) => {
    const x = argNum(a, c, 0),
      d = argNum(a, c, 1, 0);
    return isErr(x) ? x : isErr(d) ? d : round(x, d, 'down');
  },
  CEILING: (a, c) => {
    const x = argNum(a, c, 0),
      s = argNum(a, c, 1, 1);
    return isErr(x) ? x : isErr(s) ? s : s === 0 ? 0 : Math.ceil(x / s) * s;
  },
  FLOOR: (a, c) => {
    const x = argNum(a, c, 0),
      s = argNum(a, c, 1, 1);
    return isErr(x) ? x : isErr(s) ? s : s === 0 ? 0 : Math.floor(x / s) * s;
  },
  SIGN: (a, c) => {
    const x = argNum(a, c, 0);
    return isErr(x) ? x : Math.sign(x);
  },
  PI: () => Math.PI,
  RAND: () => Math.random(),
  RANDBETWEEN: (a, c) => {
    const lo = argNum(a, c, 0),
      hi = argNum(a, c, 1);
    if (isErr(lo)) return lo;
    if (isErr(hi)) return hi;
    return Math.floor(Math.random() * (Math.floor(hi) - Math.ceil(lo) + 1)) + Math.ceil(lo);
  },
  SUMPRODUCT: (args, ctx) => {
    const grids = args.map((a) => asGrid(evalNode(a, ctx)).flat());
    if (!grids.length) return 0;
    const len = grids[0].length;
    if (grids.some((g) => g.length !== len)) return ERR.VALUE;
    let sum = 0;
    for (let i = 0; i < len; i++) sum += grids.reduce((p, g) => p * (typeof g[i] === 'number' ? (g[i] as number) : 0), 1);
    return sum;
  },
  SUMIF: (args, ctx) => {
    const range = asGrid(evalNode(args[0], ctx)).flat();
    const test = matcher(arg(args, ctx, 1));
    const sumRange = args[2] ? asGrid(evalNode(args[2], ctx)).flat() : range;
    let s = 0;
    range.forEach((v, i) => {
      if (test(v) && typeof sumRange[i] === 'number') s += sumRange[i] as number;
    });
    return s;
  },
  SUMIFS: (args, ctx) => {
    const sumRange = asGrid(evalNode(args[0], ctx)).flat();
    const tests: [Scalar[], (v: Scalar) => boolean][] = [];
    for (let i = 1; i + 1 < args.length; i += 2) tests.push([asGrid(evalNode(args[i], ctx)).flat(), matcher(arg(args, ctx, i + 1))]);
    let s = 0;
    sumRange.forEach((v, i) => {
      if (typeof v === 'number' && tests.every(([r, t]) => t(r[i] ?? null))) s += v;
    });
    return s;
  },
  COUNTIF: (args, ctx) => {
    const test = matcher(arg(args, ctx, 1));
    return asGrid(evalNode(args[0], ctx)).flat().filter(test).length;
  },
  COUNTIFS: (args, ctx) => {
    const tests: [Scalar[], (v: Scalar) => boolean][] = [];
    for (let i = 0; i + 1 < args.length; i += 2) tests.push([asGrid(evalNode(args[i], ctx)).flat(), matcher(arg(args, ctx, i + 1))]);
    if (!tests.length) return 0;
    return tests[0][0].filter((_, i) => tests.every(([r, t]) => t(r[i] ?? null))).length;
  },
  AVERAGEIF: (args, ctx) => {
    const range = asGrid(evalNode(args[0], ctx)).flat();
    const test = matcher(arg(args, ctx, 1));
    const avgRange = args[2] ? asGrid(evalNode(args[2], ctx)).flat() : range;
    let s = 0,
      n = 0;
    range.forEach((v, i) => {
      if (test(v) && typeof avgRange[i] === 'number') {
        s += avgRange[i] as number;
        n++;
      }
    });
    return n ? s / n : ERR.DIV0;
  },
  IF: (args, ctx) => {
    const c = toBool(arg(args, ctx, 0));
    if (isErr(c)) return c;
    return c ? (args[1] ? evalNode(args[1], ctx) : true) : args[2] ? evalNode(args[2], ctx) : false;
  },
  IFS: (args, ctx) => {
    for (let i = 0; i + 1 < args.length; i += 2) {
      const c = toBool(arg(args, ctx, i));
      if (isErr(c)) return c;
      if (c) return evalNode(args[i + 1], ctx);
    }
    return ERR.NA;
  },
  IFERROR: (args, ctx) => {
    const v = scalar(evalNode(args[0], ctx));
    return isErr(v) ? (args[1] ? evalNode(args[1], ctx) : '') : v;
  },
  IFNA: (args, ctx) => {
    const v = scalar(evalNode(args[0], ctx));
    return isErr(v) && v.code === '#N/A' ? (args[1] ? evalNode(args[1], ctx) : '') : v;
  },
  AND: (args, ctx) => {
    for (const v of flatten(evalArgs(args, ctx))) {
      if (v === null) continue;
      const b = toBool(v);
      if (isErr(b)) return b;
      if (!b) return false;
    }
    return true;
  },
  OR: (args, ctx) => {
    for (const v of flatten(evalArgs(args, ctx))) {
      if (v === null) continue;
      const b = toBool(v);
      if (isErr(b)) return b;
      if (b) return true;
    }
    return false;
  },
  NOT: (a, c) => {
    const b = toBool(arg(a, c, 0));
    return isErr(b) ? b : !b;
  },
  TRUE: () => true,
  FALSE: () => false,
  ISBLANK: (a, c) => arg(a, c, 0) === null,
  ISNUMBER: (a, c) => typeof arg(a, c, 0) === 'number',
  ISTEXT: (a, c) => typeof arg(a, c, 0) === 'string',
  ISERROR: (a, c) => isErr(arg(a, c, 0)),
  ISNA: (a, c) => {
    const v = arg(a, c, 0);
    return isErr(v) && v.code === '#N/A';
  },
  NA: () => ERR.NA,
  LEN: (a, c) => {
    const s = argStr(a, c, 0);
    return isErr(s) ? s : s.length;
  },
  UPPER: (a, c) => {
    const s = argStr(a, c, 0);
    return isErr(s) ? s : s.toUpperCase();
  },
  LOWER: (a, c) => {
    const s = argStr(a, c, 0);
    return isErr(s) ? s : s.toLowerCase();
  },
  PROPER: (a, c) => {
    const s = argStr(a, c, 0);
    return isErr(s) ? s : s.toLowerCase().replace(/(^|[^a-z'])([a-z])/g, (_, p, l) => p + l.toUpperCase());
  },
  TRIM: (a, c) => {
    const s = argStr(a, c, 0);
    return isErr(s) ? s : s.trim().replace(/ +/g, ' ');
  },
  LEFT: (a, c) => {
    const s = argStr(a, c, 0),
      n = argNum(a, c, 1, 1);
    return isErr(s) ? s : isErr(n) ? n : s.slice(0, Math.max(0, n));
  },
  RIGHT: (a, c) => {
    const s = argStr(a, c, 0),
      n = argNum(a, c, 1, 1);
    return isErr(s) ? s : isErr(n) ? n : n <= 0 ? '' : s.slice(-n);
  },
  MID: (a, c) => {
    const s = argStr(a, c, 0),
      st = argNum(a, c, 1),
      n = argNum(a, c, 2);
    if (isErr(s)) return s;
    if (isErr(st)) return st;
    if (isErr(n)) return n;
    return st < 1 ? ERR.VALUE : s.substr(st - 1, Math.max(0, n));
  },
  CONCAT: (args, ctx) => flatten(evalArgs(args, ctx)).map(toStr).join(''),
  CONCATENATE: (args, ctx) => flatten(evalArgs(args, ctx)).map(toStr).join(''),
  TEXTJOIN: (args, ctx) => {
    const sep = argStr(args, ctx, 0);
    if (isErr(sep)) return sep;
    const skip = toBool(arg(args, ctx, 1));
    const vals = flatten(evalArgs(args.slice(2), ctx)).map(toStr);
    return (skip ? vals.filter((v) => v !== '') : vals).join(sep);
  },
  REPT: (a, c) => {
    const s = argStr(a, c, 0),
      n = argNum(a, c, 1);
    return isErr(s) ? s : isErr(n) ? n : s.repeat(Math.max(0, Math.floor(n)));
  },
  SUBSTITUTE: (a, c) => {
    const s = argStr(a, c, 0),
      f = argStr(a, c, 1),
      r = argStr(a, c, 2);
    if (isErr(s)) return s;
    if (isErr(f)) return f;
    if (isErr(r)) return r;
    if (!f) return s;
    if (a[3]) {
      const nth = argNum(a, c, 3);
      if (isErr(nth)) return nth;
      let count = 0;
      return s.replace(new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), (m) => (++count === nth ? r : m));
    }
    return s.split(f).join(r);
  },
  FIND: (a, c) => {
    const f = argStr(a, c, 0),
      s = argStr(a, c, 1),
      st = argNum(a, c, 2, 1);
    if (isErr(f)) return f;
    if (isErr(s)) return s;
    if (isErr(st)) return st;
    const i = s.indexOf(f, st - 1);
    return i < 0 ? ERR.VALUE : i + 1;
  },
  SEARCH: (a, c) => {
    const f = argStr(a, c, 0),
      s = argStr(a, c, 1),
      st = argNum(a, c, 2, 1);
    if (isErr(f)) return f;
    if (isErr(s)) return s;
    if (isErr(st)) return st;
    const i = s.toLowerCase().indexOf(f.toLowerCase(), st - 1);
    return i < 0 ? ERR.VALUE : i + 1;
  },
  VALUE: (a, c) => toNum(arg(a, c, 0)),
  TEXT: (a, c) => {
    const v = arg(a, c, 0);
    const fmt = argStr(a, c, 1);
    if (isErr(fmt)) return fmt;
    const n = toNum(v);
    if (isErr(n)) return toStr(v);
    return formatWithPattern(n, fmt);
  },
  TODAY: () => Math.floor(dateToSerial(new Date())),
  NOW: () => dateToSerial(new Date()),
  DATE: (a, c) => {
    const y = argNum(a, c, 0),
      m = argNum(a, c, 1),
      d = argNum(a, c, 2);
    if (isErr(y)) return y;
    if (isErr(m)) return m;
    if (isErr(d)) return d;
    return dateToSerial(new Date(y, m - 1, d));
  },
  YEAR: (a, c) => {
    const n = argNum(a, c, 0);
    return isErr(n) ? n : serialToDate(n).getFullYear();
  },
  MONTH: (a, c) => {
    const n = argNum(a, c, 0);
    return isErr(n) ? n : serialToDate(n).getMonth() + 1;
  },
  DAY: (a, c) => {
    const n = argNum(a, c, 0);
    return isErr(n) ? n : serialToDate(n).getDate();
  },
  WEEKDAY: (a, c) => {
    const n = argNum(a, c, 0);
    return isErr(n) ? n : serialToDate(n).getDay() + 1;
  },
  DAYS: (a, c) => {
    const e = argNum(a, c, 0),
      s = argNum(a, c, 1);
    return isErr(e) ? e : isErr(s) ? s : Math.floor(e) - Math.floor(s);
  },
  VLOOKUP: (args, ctx) => {
    const key = arg(args, ctx, 0);
    const table = asGrid(evalNode(args[1], ctx));
    const col = argNum(args, ctx, 2);
    if (isErr(col)) return col;
    const approx = args[3] ? toBool(arg(args, ctx, 3)) : true;
    if (col < 1 || col > (table[0]?.length || 0)) return ERR.REF;
    const keys = table.map((r) => r[0]);
    const i = approx === true ? lookupApprox(keys, key) : lookupExact(keys, key);
    return i < 0 ? ERR.NA : table[i][col - 1];
  },
  HLOOKUP: (args, ctx) => {
    const key = arg(args, ctx, 0);
    const table = asGrid(evalNode(args[1], ctx));
    const row = argNum(args, ctx, 2);
    if (isErr(row)) return row;
    const approx = args[3] ? toBool(arg(args, ctx, 3)) : true;
    if (row < 1 || row > table.length) return ERR.REF;
    const i = approx === true ? lookupApprox(table[0], key) : lookupExact(table[0], key);
    return i < 0 ? ERR.NA : table[row - 1][i];
  },
  INDEX: (args, ctx) => {
    const grid = asGrid(evalNode(args[0], ctx));
    let r = argNum(args, ctx, 1, 1),
      c = argNum(args, ctx, 2, 1);
    if (isErr(r)) return r;
    if (isErr(c)) return c;
    if (grid.length === 1 && args.length === 2) {
      c = r;
      r = 1;
    }
    const v = grid[r - 1]?.[c - 1];
    return v === undefined ? ERR.REF : v;
  },
  MATCH: (args, ctx) => {
    const key = arg(args, ctx, 0);
    const arr = asGrid(evalNode(args[1], ctx)).flat();
    const type = argNum(args, ctx, 2, 1);
    if (isErr(type)) return type;
    const i = type === 0 ? lookupExact(arr, key) : lookupApprox(arr, key);
    return i < 0 ? ERR.NA : i + 1;
  },
  XLOOKUP: (args, ctx) => {
    const key = arg(args, ctx, 0);
    const look = asGrid(evalNode(args[1], ctx)).flat();
    const ret = asGrid(evalNode(args[2], ctx));
    const i = lookupExact(look, key);
    if (i < 0) return args[3] ? evalNode(args[3], ctx) : ERR.NA;
    return ret.length === 1 ? ret[0][i] : ret[i]?.[0] ?? ERR.NA;
  },
  ROWS: (a, c) => asGrid(evalNode(a[0], c)).length,
  COLUMNS: (a, c) => asGrid(evalNode(a[0], c))[0]?.length || 0,
  CHOOSE: (args, ctx) => {
    const i = argNum(args, ctx, 0);
    if (isErr(i)) return i;
    return args[i] ? evalNode(args[i], ctx) : ERR.VALUE;
  }
};

// ---------- More functions: dynamic arrays, statistics, finance, dates, maths, text ----------
const g = (args: Node[], ctx: EvalContext, i: number): Scalar[][] => asGrid(evalNode(args[i], ctx));
const truthy = (v: Scalar) => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : typeof v === 'string' ? v.toUpperCase() === 'TRUE' : false);
const nums = (vals: Scalar[]) => vals.filter((v): v is number => typeof v === 'number');
const sortedNums = (vals: Scalar[]) => nums(vals).sort((a, b) => a - b);
const transpose = (m: Scalar[][]) => (m[0] || []).map((_, c) => m.map((row) => row[c] ?? null));
const meanOf = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const variance = (a: number[], sample: boolean) => {
  if (a.length < (sample ? 2 : 1)) return ERR.DIV0;
  const m = meanOf(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - (sample ? 1 : 0));
};
const percentile = (a: number[], p: number) => {
  if (!a.length || p < 0 || p > 1) return ERR.NUM;
  const idx = (a.length - 1) * p;
  const lo = Math.floor(idx);
  return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (idx - lo);
};
const pairs = (args: Node[], ctx: EvalContext) => {
  const ys = g(args, ctx, 0).flat();
  const xs = g(args, ctx, 1).flat();
  const out: [number, number][] = [];
  ys.forEach((y, i) => typeof y === 'number' && typeof xs[i] === 'number' && out.push([xs[i] as number, y]));
  return out;
};
const regress = (p: [number, number][]) => {
  const mx = meanOf(p.map((q) => q[0]));
  const my = meanOf(p.map((q) => q[1]));
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (const [x, y] of p) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return { slope: sxy / sxx, intercept: my - (sxy / sxx) * mx, r: sxy / Math.sqrt(sxx * syy) };
};
const condsFn = (agg: (vals: number[]) => Scalar): Fn => (args, ctx) => {
  const target = g(args, ctx, 0).flat();
  const tests: [Scalar[], (v: Scalar) => boolean][] = [];
  for (let i = 1; i + 1 < args.length; i += 2) tests.push([g(args, ctx, i).flat(), matcher(arg(args, ctx, i + 1))]);
  return agg(target.filter((v, i) => typeof v === 'number' && tests.every(([r, t]) => t(r[i] ?? null))) as number[]);
};
const num1 = (f: (x: number) => number): Fn => (args, ctx) => {
  const x = argNum(args, ctx, 0);
  if (isErr(x)) return x;
  const r = f(x);
  return isFinite(r) ? r : ERR.NUM;
};
const gcd2 = (a: number, b: number): number => (b ? gcd2(b, a % b) : Math.abs(a));
const fact = (n: number) => {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
};
const dateParts = (args: Node[], ctx: EvalContext, i: number) => {
  const n = argNum(args, ctx, i);
  return isErr(n) ? n : serialToDate(n);
};
const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;
const pmt = (rate: number, nper: number, pv: number, fv = 0, type = 0) =>
  rate === 0 ? -(pv + fv) / nper : (-rate * (pv * Math.pow(1 + rate, nper) + fv)) / ((1 + rate * type) * (Math.pow(1 + rate, nper) - 1));

Object.assign(FUNCS, {
  // Dynamic arrays (spill into neighbouring cells)
  FILTER: ((args, ctx) => {
    const data = g(args, ctx, 0);
    const inc = g(args, ctx, 1);
    let out: Scalar[][];
    if (inc.length === data.length && (inc[0]?.length || 1) === 1) out = data.filter((_, r) => truthy(inc[r][0]));
    else if (inc.length === 1 && inc[0].length === (data[0]?.length || 0)) out = data.map((row) => row.filter((_, c) => truthy(inc[0][c])));
    else return ERR.VALUE;
    if (!out.length || !out[0].length) return args[2] ? evalNode(args[2], ctx) : ERR.CALC;
    return out;
  }) as Fn,
  SORT: ((args, ctx) => {
    let data = g(args, ctx, 0);
    const idx = (args[1] ? (toNum(arg(args, ctx, 1)) as number) : 1) - 1;
    const order = args[2] ? (toNum(arg(args, ctx, 2)) as number) : 1;
    const byCol = args[3] ? truthy(arg(args, ctx, 3)) : false;
    if (byCol) data = transpose(data);
    const sorted = [...data].sort((a, b) => compare(a[idx] ?? null, b[idx] ?? null) * (order < 0 ? -1 : 1));
    return byCol ? transpose(sorted) : sorted;
  }) as Fn,
  SORTBY: ((args, ctx) => {
    const data = g(args, ctx, 0);
    const keys: { col: Scalar[]; order: number }[] = [];
    for (let i = 1; i < args.length; i += 2) keys.push({ col: g(args, ctx, i).flat(), order: args[i + 1] ? (toNum(arg(args, ctx, i + 1)) as number) : 1 });
    const idx = data.map((_, i) => i);
    idx.sort((a, b) => {
      for (const k of keys) {
        const c = compare(k.col[a] ?? null, k.col[b] ?? null);
        if (c) return k.order < 0 ? -c : c;
      }
      return 0;
    });
    return idx.map((i) => data[i]);
  }) as Fn,
  UNIQUE: ((args, ctx) => {
    let data = g(args, ctx, 0);
    const byCol = args[1] ? truthy(arg(args, ctx, 1)) : false;
    const once = args[2] ? truthy(arg(args, ctx, 2)) : false;
    if (byCol) data = transpose(data);
    const keyOf = (row: Scalar[]) => JSON.stringify(row.map((v) => (typeof v === 'string' ? v.toLowerCase() : v)));
    const counts = new Map<string, number>();
    data.forEach((row) => counts.set(keyOf(row), (counts.get(keyOf(row)) || 0) + 1));
    const seen = new Set<string>();
    const out = data.filter((row) => {
      const k = keyOf(row);
      if (seen.has(k) || (once && counts.get(k)! > 1)) return false;
      seen.add(k);
      return true;
    });
    if (!out.length) return ERR.CALC;
    return byCol ? transpose(out) : out;
  }) as Fn,
  SEQUENCE: ((args, ctx) => {
    const rows = Math.floor(toNum(arg(args, ctx, 0)) as number);
    const cols = args[1] ? Math.floor(toNum(arg(args, ctx, 1)) as number) : 1;
    const start = args[2] ? (toNum(arg(args, ctx, 2)) as number) : 1;
    const step = args[3] ? (toNum(arg(args, ctx, 3)) as number) : 1;
    if (!(rows > 0) || !(cols > 0) || rows * cols > 100000) return ERR.VALUE;
    return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => start + (r * cols + c) * step));
  }) as Fn,
  TRANSPOSE: ((args, ctx) => transpose(g(args, ctx, 0))) as Fn,
  RANDARRAY: ((args, ctx) => {
    const rows = args[0] ? Math.floor(toNum(arg(args, ctx, 0)) as number) : 1;
    const cols = args[1] ? Math.floor(toNum(arg(args, ctx, 1)) as number) : 1;
    const lo = args[2] ? (toNum(arg(args, ctx, 2)) as number) : 0;
    const hi = args[3] ? (toNum(arg(args, ctx, 3)) as number) : 1;
    const whole = args[4] ? truthy(arg(args, ctx, 4)) : false;
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => (whole ? Math.floor(lo + Math.random() * (hi - lo + 1)) : lo + Math.random() * (hi - lo))));
  }) as Fn,
  TEXTSPLIT: ((args, ctx) => {
    const text = argStr(args, ctx, 0);
    const colSep = argStr(args, ctx, 1);
    if (isErr(text) || isErr(colSep)) return ERR.VALUE;
    const rowSep = args[2] ? (argStr(args, ctx, 2) as string) : '';
    const rows = rowSep ? text.split(rowSep) : [text];
    const out = rows.map((r) => (colSep ? r.split(colSep) : [r]));
    const w = Math.max(...out.map((r) => r.length));
    return out.map((r) => [...r, ...Array(w - r.length).fill(null)]);
  }) as Fn,

  // Conditional aggregates
  AVERAGEIFS: condsFn((v) => (v.length ? meanOf(v) : ERR.DIV0)),
  MINIFS: condsFn((v) => (v.length ? Math.min(...v) : 0)),
  MAXIFS: condsFn((v) => (v.length ? Math.max(...v) : 0)),
  COUNTUNIQUE: ((args, ctx) => new Set(flatten(evalArgs(args, ctx)).filter((v) => v !== null && v !== '').map((v) => (typeof v === 'string' ? v.toLowerCase() : String(v)))).size) as Fn,

  // Logic
  SWITCH: ((args, ctx) => {
    const v = arg(args, ctx, 0);
    for (let i = 1; i + 1 < args.length; i += 2) if (compare(v, arg(args, ctx, i)) === 0) return evalNode(args[i + 1], ctx);
    return args.length % 2 === 0 ? evalNode(args[args.length - 1], ctx) : ERR.NA;
  }) as Fn,
  XOR: ((args, ctx) => flatten(evalArgs(args, ctx)).filter((v) => truthy(v)).length % 2 === 1) as Fn,
  ISEVEN: num1((x) => (Math.trunc(x) % 2 === 0 ? 1 : 0)),
  ISODD: num1((x) => (Math.abs(Math.trunc(x)) % 2 === 1 ? 1 : 0)),
  ISLOGICAL: ((args, ctx) => typeof arg(args, ctx, 0) === 'boolean') as Fn,
  ISNONTEXT: ((args, ctx) => typeof arg(args, ctx, 0) !== 'string') as Fn,
  N: ((args, ctx) => {
    const v = arg(args, ctx, 0);
    return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0;
  }) as Fn,
  T: ((args, ctx) => {
    const v = arg(args, ctx, 0);
    return typeof v === 'string' ? v : '';
  }) as Fn,

  // Statistics
  LARGE: ((args, ctx) => {
    const a = sortedNums(g(args, ctx, 0).flat()).reverse();
    const k = toNum(arg(args, ctx, 1)) as number;
    return a[k - 1] ?? ERR.NUM;
  }) as Fn,
  SMALL: ((args, ctx) => {
    const a = sortedNums(g(args, ctx, 0).flat());
    const k = toNum(arg(args, ctx, 1)) as number;
    return a[k - 1] ?? ERR.NUM;
  }) as Fn,
  RANK: ((args, ctx) => {
    const x = toNum(arg(args, ctx, 0));
    if (isErr(x)) return x;
    const asc = args[2] ? truthy(arg(args, ctx, 2)) : false;
    const a = nums(g(args, ctx, 1).flat());
    if (!a.includes(x)) return ERR.NA;
    return a.filter((v) => (asc ? v < x : v > x)).length + 1;
  }) as Fn,
  PERCENTILE: ((args, ctx) => percentile(sortedNums(g(args, ctx, 0).flat()), toNum(arg(args, ctx, 1)) as number)) as Fn,
  QUARTILE: ((args, ctx) => percentile(sortedNums(g(args, ctx, 0).flat()), (toNum(arg(args, ctx, 1)) as number) / 4)) as Fn,
  MODE: numFn((a) => {
    const counts = new Map<number, number>();
    a.forEach((x) => counts.set(x, (counts.get(x) || 0) + 1));
    let best: number | null = null;
    let bc = 1;
    for (const x of a) if ((counts.get(x) || 0) > bc) (best = x), (bc = counts.get(x)!);
    return best === null ? ERR.NA : best;
  }),
  'STDEV.P': numFn((a) => {
    const v = variance(a, false);
    return isErr(v) ? v : Math.sqrt(v);
  }),
  'VAR.P': numFn((a) => variance(a, false)),
  SUMSQ: numFn((a) => a.reduce((s, x) => s + x * x, 0)),
  CORREL: ((args, ctx) => {
    const p = pairs(args, ctx);
    return p.length < 2 ? ERR.DIV0 : regress(p).r;
  }) as Fn,
  RSQ: ((args, ctx) => {
    const p = pairs(args, ctx);
    return p.length < 2 ? ERR.DIV0 : regress(p).r ** 2;
  }) as Fn,
  SLOPE: ((args, ctx) => {
    const p = pairs(args, ctx);
    return p.length < 2 ? ERR.DIV0 : regress(p).slope;
  }) as Fn,
  INTERCEPT: ((args, ctx) => {
    const p = pairs(args, ctx);
    return p.length < 2 ? ERR.DIV0 : regress(p).intercept;
  }) as Fn,
  FORECAST: ((args, ctx) => {
    const x = toNum(arg(args, ctx, 0));
    if (isErr(x)) return x;
    const ys = g(args, ctx, 1).flat();
    const xs = g(args, ctx, 2).flat();
    const p: [number, number][] = [];
    ys.forEach((y, i) => typeof y === 'number' && typeof xs[i] === 'number' && p.push([xs[i] as number, y]));
    if (p.length < 2) return ERR.DIV0;
    const r = regress(p);
    return r.intercept + r.slope * x;
  }) as Fn,

  // Finance
  PMT: ((args, ctx) => {
    const [r, n, pv, fv, t] = [0, 1, 2, 3, 4].map((i) => (args[i] ? (toNum(arg(args, ctx, i)) as number) : 0));
    return n ? pmt(r, n, pv, fv, t) : ERR.NUM;
  }) as Fn,
  FV: ((args, ctx) => {
    const [r, n, p, pv, t] = [0, 1, 2, 3, 4].map((i) => (args[i] ? (toNum(arg(args, ctx, i)) as number) : 0));
    if (r === 0) return -(pv + p * n);
    const f = Math.pow(1 + r, n);
    return -(pv * f + (p * (1 + r * t) * (f - 1)) / r);
  }) as Fn,
  PV: ((args, ctx) => {
    const [r, n, p, fv, t] = [0, 1, 2, 3, 4].map((i) => (args[i] ? (toNum(arg(args, ctx, i)) as number) : 0));
    if (r === 0) return -(fv + p * n);
    const f = Math.pow(1 + r, n);
    return -(fv + (p * (1 + r * t) * (f - 1)) / r) / f;
  }) as Fn,
  NPER: ((args, ctx) => {
    const [r, p, pv, fv, t] = [0, 1, 2, 3, 4].map((i) => (args[i] ? (toNum(arg(args, ctx, i)) as number) : 0));
    if (r === 0) return p ? -(pv + fv) / p : ERR.NUM;
    const z = p * (1 + r * t);
    const v = Math.log((z - fv * r) / (z + pv * r)) / Math.log(1 + r);
    return isFinite(v) ? v : ERR.NUM;
  }) as Fn,
  NPV: ((args, ctx) => {
    const r = toNum(arg(args, ctx, 0));
    if (isErr(r)) return r;
    const flows = nums(flatten(args.slice(1).map((a) => evalNode(a, ctx))));
    return flows.reduce((s, cf, i) => s + cf / Math.pow(1 + r, i + 1), 0);
  }) as Fn,
  IRR: ((args, ctx) => {
    const flows = nums(g(args, ctx, 0).flat());
    let rate = args[1] ? (toNum(arg(args, ctx, 1)) as number) : 0.1;
    for (let i = 0; i < 100; i++) {
      let f = 0,
        df = 0;
      flows.forEach((cf, t) => {
        f += cf / Math.pow(1 + rate, t);
        df -= (t * cf) / Math.pow(1 + rate, t + 1);
      });
      if (Math.abs(f) < 1e-9) return rate;
      if (!df) break;
      rate -= f / df;
    }
    return Math.abs(flows.reduce((s, cf, t) => s + cf / Math.pow(1 + rate, t), 0)) < 1e-6 ? rate : ERR.NUM;
  }) as Fn,
  RATE: ((args, ctx) => {
    const [n, p, pv, fv, t] = [0, 1, 2, 3, 4].map((i) => (args[i] ? (toNum(arg(args, ctx, i)) as number) : 0));
    let r = args[5] ? (toNum(arg(args, ctx, 5)) as number) : 0.1;
    const f = (x: number) => pv * Math.pow(1 + x, n) + p * (1 + x * t) * ((Math.pow(1 + x, n) - 1) / x) + fv;
    for (let i = 0; i < 100; i++) {
      const y = f(r);
      if (Math.abs(y) < 1e-9) return r;
      const d = (f(r + 1e-6) - y) / 1e-6;
      if (!d) break;
      r -= y / d;
    }
    return Math.abs(f(r)) < 1e-6 ? r : ERR.NUM;
  }) as Fn,

  // Maths
  TRUNC: ((args, ctx) => {
    const x = argNum(args, ctx, 0);
    const d = argNum(args, ctx, 1, 0);
    if (isErr(x)) return x;
    if (isErr(d)) return d;
    const f = Math.pow(10, d);
    return Math.trunc(x * f) / f;
  }) as Fn,
  EVEN: num1((x) => (x < 0 ? -1 : 1) * Math.ceil(Math.abs(x) / 2) * 2),
  ODD: num1((x) => {
    const s = x < 0 ? -1 : 1;
    let v = Math.ceil(Math.abs(x));
    if (v % 2 === 0) v++;
    return s * v;
  }),
  MROUND: ((args, ctx) => {
    const x = argNum(args, ctx, 0);
    const m = argNum(args, ctx, 1);
    if (isErr(x)) return x;
    if (isErr(m)) return m;
    return m === 0 ? 0 : Math.round(x / m) * m;
  }) as Fn,
  QUOTIENT: ((args, ctx) => {
    const a = argNum(args, ctx, 0);
    const b = argNum(args, ctx, 1);
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    return b === 0 ? ERR.DIV0 : Math.trunc(a / b);
  }) as Fn,
  GCD: numFn((a) => a.map((x) => Math.trunc(x)).reduce(gcd2, 0)),
  LCM: numFn((a) => a.map((x) => Math.trunc(x)).reduce((l, x) => (l && x ? Math.abs(l * x) / gcd2(l, x) : 0), 1)),
  FACT: num1((x) => (x < 0 ? NaN : fact(Math.floor(x)))),
  COMBIN: ((args, ctx) => {
    const n = Math.floor(toNum(arg(args, ctx, 0)) as number);
    const k = Math.floor(toNum(arg(args, ctx, 1)) as number);
    return k < 0 || k > n ? ERR.NUM : Math.round(fact(n) / (fact(k) * fact(n - k)));
  }) as Fn,
  PERMUT: ((args, ctx) => {
    const n = Math.floor(toNum(arg(args, ctx, 0)) as number);
    const k = Math.floor(toNum(arg(args, ctx, 1)) as number);
    return k < 0 || k > n ? ERR.NUM : Math.round(fact(n) / fact(n - k));
  }) as Fn,
  DEGREES: num1((x) => (x * 180) / Math.PI),
  RADIANS: num1((x) => (x * Math.PI) / 180),
  SIN: num1(Math.sin),
  COS: num1(Math.cos),
  TAN: num1(Math.tan),
  ASIN: num1(Math.asin),
  ACOS: num1(Math.acos),
  ATAN: num1(Math.atan),
  SINH: num1(Math.sinh),
  COSH: num1(Math.cosh),
  TANH: num1(Math.tanh),
  ATAN2: ((args, ctx) => {
    const x = argNum(args, ctx, 0);
    const y = argNum(args, ctx, 1);
    if (isErr(x)) return x;
    if (isErr(y)) return y;
    return Math.atan2(y, x);
  }) as Fn,

  // Text
  EXACT: ((args, ctx) => toStr(arg(args, ctx, 0)) === toStr(arg(args, ctx, 1))) as Fn,
  CHAR: num1((x) => x) as Fn,
  CODE: ((args, ctx) => {
    const s = argStr(args, ctx, 0);
    return isErr(s) ? s : s ? s.charCodeAt(0) : ERR.VALUE;
  }) as Fn,
  CLEAN: ((args, ctx) => {
    const s = argStr(args, ctx, 0);
    return isErr(s) ? s : s.replace(/[\x00-\x1f]/g, '');
  }) as Fn,
  NUMBERVALUE: ((args, ctx) => {
    const s = argStr(args, ctx, 0);
    if (isErr(s)) return s;
    const n = Number(s.replace(/[,\s]/g, '').replace(/%$/, ''));
    return isNaN(n) ? ERR.VALUE : s.trim().endsWith('%') ? n / 100 : n;
  }) as Fn,
  TEXTBEFORE: ((args, ctx) => {
    const s = argStr(args, ctx, 0);
    const d = argStr(args, ctx, 1);
    if (isErr(s) || isErr(d)) return ERR.VALUE;
    const i = s.indexOf(d);
    return i < 0 ? ERR.NA : s.slice(0, i);
  }) as Fn,
  TEXTAFTER: ((args, ctx) => {
    const s = argStr(args, ctx, 0);
    const d = argStr(args, ctx, 1);
    if (isErr(s) || isErr(d)) return ERR.VALUE;
    const i = s.indexOf(d);
    return i < 0 ? ERR.NA : s.slice(i + d.length);
  }) as Fn,
  HYPERLINK: ((args, ctx) => (args[1] ? arg(args, ctx, 1) : arg(args, ctx, 0))) as Fn,

  // Dates and times
  HOUR: ((args, ctx) => {
    const n = argNum(args, ctx, 0);
    return isErr(n) ? n : Math.floor(((n % 1) * 24 + 1e-9) % 24);
  }) as Fn,
  MINUTE: ((args, ctx) => {
    const n = argNum(args, ctx, 0);
    return isErr(n) ? n : Math.floor(((n % 1) * 1440 + 1e-9) % 60);
  }) as Fn,
  SECOND: ((args, ctx) => {
    const n = argNum(args, ctx, 0);
    return isErr(n) ? n : Math.round((n % 1) * 86400) % 60;
  }) as Fn,
  TIME: ((args, ctx) => {
    const [h, m, s] = [0, 1, 2].map((i) => toNum(arg(args, ctx, i)) as number);
    return ((h * 3600 + m * 60 + s) / 86400) % 1;
  }) as Fn,
  EDATE: ((args, ctx) => {
    const d = dateParts(args, ctx, 0);
    const m = argNum(args, ctx, 1);
    if (isErr(d)) return d;
    if (isErr(m)) return m;
    return Math.floor(dateToSerial(new Date(d.getFullYear(), d.getMonth() + Math.trunc(m), d.getDate())));
  }) as Fn,
  EOMONTH: ((args, ctx) => {
    const d = dateParts(args, ctx, 0);
    const m = argNum(args, ctx, 1);
    if (isErr(d)) return d;
    if (isErr(m)) return m;
    return Math.floor(dateToSerial(new Date(d.getFullYear(), d.getMonth() + Math.trunc(m) + 1, 0)));
  }) as Fn,
  NETWORKDAYS: ((args, ctx) => {
    const a = dateParts(args, ctx, 0);
    const b = dateParts(args, ctx, 1);
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    const holidays = new Set(args[2] ? nums(g(args, ctx, 2).flat()).map((x) => Math.floor(x)) : []);
    const [s, e, sign] = a <= b ? [a, b, 1] : [b, a, -1];
    let n = 0;
    for (const d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) if (!isWeekend(d) && !holidays.has(Math.floor(dateToSerial(d)))) n++;
    return n * sign;
  }) as Fn,
  WORKDAY: ((args, ctx) => {
    const a = dateParts(args, ctx, 0);
    const days = argNum(args, ctx, 1);
    if (isErr(a)) return a;
    if (isErr(days)) return days;
    const holidays = new Set(args[2] ? nums(g(args, ctx, 2).flat()).map((x) => Math.floor(x)) : []);
    const d = new Date(a);
    let left = Math.abs(Math.trunc(days));
    const step = days < 0 ? -1 : 1;
    while (left > 0) {
      d.setDate(d.getDate() + step);
      if (!isWeekend(d) && !holidays.has(Math.floor(dateToSerial(d)))) left--;
    }
    return Math.floor(dateToSerial(d));
  }) as Fn,
  DATEDIF: ((args, ctx) => {
    const a = dateParts(args, ctx, 0);
    const b = dateParts(args, ctx, 1);
    const unit = argStr(args, ctx, 2);
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    if (isErr(unit) || a > b) return ERR.NUM;
    let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
    if (b.getDate() < a.getDate()) months--;
    switch (unit.toUpperCase()) {
      case 'Y':
        return Math.floor(months / 12);
      case 'M':
        return months;
      case 'D':
        return Math.round((b.getTime() - a.getTime()) / 864e5);
      case 'YM':
        return months % 12;
      case 'MD':
        return b.getDate() >= a.getDate() ? b.getDate() - a.getDate() : new Date(b.getFullYear(), b.getMonth(), 0).getDate() - a.getDate() + b.getDate();
      default:
        return ERR.NUM;
    }
  }) as Fn,
  WEEKNUM: ((args, ctx) => {
    const d = dateParts(args, ctx, 0);
    if (isErr(d)) return d;
    const jan1 = new Date(d.getFullYear(), 0, 1);
    return Math.floor((Math.round((d.getTime() - jan1.getTime()) / 864e5) + jan1.getDay()) / 7) + 1;
  }) as Fn,
  DATEVALUE: ((args, ctx) => {
    const s = argStr(args, ctx, 0);
    if (isErr(s)) return s;
    const t = Date.parse(s);
    return isNaN(t) ? ERR.VALUE : Math.floor(dateToSerial(new Date(t)));
  }) as Fn
} as Record<string, Fn>);
// Excel's newer dotted names.
FUNCS['STDEV.S'] = FUNCS.STDEV;
FUNCS['VAR.S'] = FUNCS.VAR;
FUNCS.STDEVP = FUNCS['STDEV.P'];
FUNCS.VARP = FUNCS['VAR.P'];
FUNCS['RANK.EQ'] = FUNCS.RANK;
FUNCS['PERCENTILE.INC'] = FUNCS.PERCENTILE;
FUNCS['QUARTILE.INC'] = FUNCS.QUARTILE;
FUNCS['MODE.SNGL'] = FUNCS.MODE;
FUNCS['FORECAST.LINEAR'] = FUNCS.FORECAST;
FUNCS.CHAR = (args, ctx) => {
  const n = argNum(args, ctx, 0);
  return isErr(n) ? n : String.fromCharCode(n);
};

export const FUNCTION_NAMES = Object.keys(FUNCS).sort();

/** Minimal Excel number-format patterns for TEXT() and imported formats. */
export function formatWithPattern(n: number, pattern: string): string {
  const p = pattern.split(';')[n < 0 && pattern.includes(';') ? 1 : 0] || pattern;
  if (/[ymdhs]/i.test(p) && !/0/.test(p)) {
    const d = serialToDate(n);
    const pad = (x: number, l = 2) => String(x).padStart(l, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return p
      .replace(/\[[^\]]*\]/g, '')
      .replace(/yyyy/gi, String(d.getFullYear()))
      .replace(/yy/gi, String(d.getFullYear()).slice(-2))
      .replace(/mmmm/gi, months[d.getMonth()].length > 3 ? months[d.getMonth()] : d.toLocaleString('en', { month: 'long' }))
      .replace(/mmm/gi, months[d.getMonth()])
      .replace(/(h+)(:)(mm)/gi, (_m, h, c) => `${h}${c}${pad(d.getMinutes())}`)
      .replace(/mm/gi, pad(d.getMonth() + 1))
      .replace(/(?<![a-z])m(?![a-z])/gi, String(d.getMonth() + 1))
      .replace(/dd/gi, pad(d.getDate()))
      .replace(/(?<![a-z])d(?![a-z])/gi, String(d.getDate()))
      .replace(/hh/gi, pad(d.getHours()))
      .replace(/(?<![a-z])h(?![a-z])/gi, String(d.getHours()))
      .replace(/ss/gi, pad(d.getSeconds()))
      .replace(/\\/g, '')
      .replace(/"/g, '');
  }
  const pct = p.includes('%');
  const v = pct ? n * 100 : n;
  const dec = (p.split('.')[1] || '').replace(/[^0#]/g, '').length;
  const grouping = p.includes(',');
  const body = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: grouping });
  const prefix = (p.match(/^[^0#.,]*/)?.[0] || '').replace(/["\\]/g, '').replace(/\[.*?\]/g, '');
  const suffix = (p.match(/[^0#.,%]*$/)?.[0] || '').replace(/["\\_)\-*\s]/g, '');
  return (v < 0 && !pattern.includes(';') ? '-' : '') + prefix.replace(/[_)(\-*]/g, '').replace(/\s+$/, '') + body + (pct ? '%' : '') + suffix;
}

// ---------- Reference rewriting ----------
/** Shift relative references (copy/paste, fill). */
export function shiftFormula(formula: string, dr: number, dc: number): string {
  try {
    return tokenize(formula)
      .map((t) => {
        if (t.t !== 'ref') return t.s;
        if (t.whole) return t.s;
        const r1 = t.abs[1] ? t.r1 : t.r1 + dr;
        const c1 = t.abs[0] ? t.c1 : t.c1 + dc;
        if (r1 < 0 || c1 < 0) return '#REF!';
        let s = sheetPrefix(t.sheet) + cellStr(c1, r1, t.abs[0], t.abs[1]);
        if (t.c2 !== undefined) {
          const r2 = t.abs[3] ? t.r2! : t.r2! + dr;
          const c2 = t.abs[2] ? t.c2 : t.c2 + dc;
          if (r2 < 0 || c2 < 0) return '#REF!';
          s += ':' + cellStr(c2, r2, t.abs[2], t.abs[3]);
        }
        return s;
      })
      .join('');
  } catch {
    return formula;
  }
}

/** Adjust references after inserting (count > 0) or deleting (count < 0) rows or columns. */
export function adjustForInsert(formula: string, targetSheet: string, formulaSheet: string, axis: 'row' | 'col', at: number, count: number): string {
  try {
    return tokenize(formula)
      .map((t) => {
        if (t.t !== 'ref') return t.s;
        const sheet = t.sheet ?? formulaSheet;
        if (sheet.toLowerCase() !== targetSheet.toLowerCase()) return t.s;
        const move = (v: number) => {
          if (count > 0) return v >= at ? v + count : v;
          if (v >= at && v < at - count) return null;
          return v >= at - count ? v + count : v;
        };
        let c1 = t.c1,
          r1 = t.r1,
          c2 = t.c2,
          r2 = t.r2;
        if (axis === 'row' && t.whole !== 'col') {
          if (t.r2 === undefined) {
            const n = move(r1);
            if (n === null) return '#REF!';
            r1 = n;
          } else {
            const lo = Math.min(r1, r2!),
              hi = Math.max(r1, r2!);
            let nlo = move(lo),
              nhi = move(hi);
            if (nlo === null && nhi === null) return '#REF!';
            if (nlo === null) nlo = at;
            if (nhi === null) nhi = at - 1;
            r1 = nlo;
            r2 = nhi;
          }
        }
        if (axis === 'col') {
          if (t.c2 === undefined) {
            const n = move(c1);
            if (n === null) return '#REF!';
            c1 = n;
          } else {
            const lo = Math.min(c1, c2!),
              hi = Math.max(c1, c2!);
            let nlo = move(lo),
              nhi = move(hi);
            if (nlo === null && nhi === null) return '#REF!';
            if (nlo === null) nlo = at;
            if (nhi === null) nhi = at - 1;
            c1 = nlo;
            c2 = nhi;
          }
        }
        if (t.whole === 'col') return sheetPrefix(t.sheet) + `${t.abs[0] ? '$' : ''}${colName(c1)}:${t.abs[2] ? '$' : ''}${colName(c2!)}`;
        let s = sheetPrefix(t.sheet) + cellStr(c1, r1, t.abs[0], t.abs[1]);
        if (c2 !== undefined) s += ':' + cellStr(c2, r2!, t.abs[2], t.abs[3]);
        return s;
      })
      .join('');
  } catch {
    return formula;
  }
}

/** Rewrite references to a renamed sheet. */
export function renameSheetRefs(formula: string, oldName: string, newName: string): string {
  try {
    return tokenize(formula)
      .map((t) => (t.t === 'ref' && t.sheet && t.sheet.toLowerCase() === oldName.toLowerCase() ? sheetPrefix(newName) + t.s.slice(t.s.indexOf('!') + 1) : t.s))
      .join('');
  } catch {
    return formula;
  }
}

const cellStr = (c: number, r: number, ac: boolean, ar: boolean) => `${ac ? '$' : ''}${colName(c)}${ar ? '$' : ''}${r + 1}`;
export const sheetPrefix = (sheet?: string) => (sheet ? (/^[A-Za-z_][\w.]*$/.test(sheet) ? `${sheet}!` : `'${sheet.replace(/'/g, "''")}'!`) : '');

/** References in a formula, for highlighting while editing. */
export function formulaRefs(formula: string): { sheet?: string; r1: number; c1: number; r2: number; c2: number }[] {
  try {
    return tokenize(formula)
      .filter((t): t is Extract<Token, { t: 'ref' }> => t.t === 'ref' && !t.whole)
      .map((t) => ({ sheet: t.sheet, r1: Math.min(t.r1, t.r2 ?? t.r1), c1: Math.min(t.c1, t.c2 ?? t.c1), r2: Math.max(t.r1, t.r2 ?? t.r1), c2: Math.max(t.c1, t.c2 ?? t.c1) }));
  } catch {
    return [];
  }
}

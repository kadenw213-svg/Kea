// Math in study text, drawn as math: questions are written as plain text, where an exponent reads "(1.00375)^72" or
// "e^(0.038·10)" and a subscript "log_b(x)". These become real superscripts and subscripts (nested where they nest),
// and the few LaTeX commands a writer might slip in become their symbols. Blanks ("____") and prices ("$8,000") are
// left as they are.
import { Fragment, ReactNode } from 'react';

export const LATEX: Record<string, string> = {
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈',
  to: '→', rightarrow: '→', leftarrow: '←', rightleftharpoons: '⇌', infty: '∞', circ: '°', degree: '°',
  Delta: 'Δ', delta: 'δ', alpha: 'α', beta: 'β', gamma: 'γ', lambda: 'λ', mu: 'μ', pi: 'π', theta: 'θ', sigma: 'σ', Sigma: 'Σ',
  omega: 'ω', Omega: 'Ω', rho: 'ρ', epsilon: 'ε', nu: 'ν', sqrt: '√', ln: 'ln', log: 'log', sin: 'sin', cos: 'cos', tan: 'tan'
};

/** Plain text with the LaTeX a writer may have slipped in turned into symbols ("\frac{a}{b}" → "(a)/(b)"). */
function unlatex(s: string) {
  return s
    .replace(/\\\(|\\\)|\\\[|\\\]/g, '')
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (_m, a, b) => `${/^[\w.]+$/.test(a) ? a : `(${a})`}/${/^[\w.]+$/.test(b) ? b : `(${b})`}`)
    .replace(/\\text\{([^{}]*)\}|\\mathrm\{([^{}]*)\}/g, (_m, a, b) => a ?? b)
    .replace(/\\sqrt\{([^{}]*)\}/g, '√($1)')
    .replace(/\\([A-Za-z]+)/g, (m, name) => LATEX[name] ?? m);
}

/** The end of the group opening at s[i] ("(" or "{"), or -1. */
function closing(s: string, i: number) {
  const open = s[i];
  const close = open === '(' ? ')' : '}';
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j;
  }
  return -1;
}

function parse(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  let text = '';
  let key = 0;
  const flush = () => {
    if (text) out.push(<Fragment key={key++}>{text}</Fragment>);
    text = '';
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const prev = s[i - 1] || '';
    const nextCh = s[i + 1] || '';
    const isSup = ch === '^';
    // A subscript: one underscore after a letter or digit, followed by a letter/digit/group ("log_b", "x_1", "K_{sp}"),
    // never part of a blank ("____").
    const isSub = ch === '_' && /[A-Za-z0-9)]/.test(prev) && /[A-Za-z0-9({]/.test(nextCh) && prev !== '_' && nextCh !== '_';
    if (!isSup && !isSub) {
      text += ch;
      continue;
    }
    let body = '';
    let end = i;
    if (nextCh === '(' || nextCh === '{') {
      const j = closing(s, i + 1);
      if (j < 0) {
        text += ch;
        continue;
      }
      // (Parentheses stay when they group more than one thing: "e^(rt)" shows as e with "rt" raised.)
      body = s.slice(i + 2, j);
      end = j;
    } else {
      // (An ion's charge counts: "Ag^+", "SO4^2-"; a sign followed by more math, as in "e^x-1", doesn't.)
      const m = (isSup ? /^[-−+]?[A-Za-z0-9.]*(?:[-−+](?![A-Za-z0-9(]))?/ : /^[A-Za-z0-9]+/).exec(s.slice(i + 1));
      if (!m || !m[0]) {
        text += ch;
        continue;
      }
      // (A trailing period ends the sentence, not the exponent.)
      body = m[0].replace(/\.$/, '');
      end = i + body.length;
    }
    flush();
    out.push(isSup ? <sup key={key++}>{parse(body)}</sup> : <sub key={key++}>{parse(body)}</sub>);
    i = end;
  }
  flush();
  return out;
}

/** Study text (a question, a choice, an explanation, a card side) with its math drawn as math. */
export function MathText({ text }: { text: string | number | null | undefined }) {
  const s = text == null ? '' : String(text);
  if (!/[\^_\\]/.test(s)) return <>{s}</>;
  return <>{parse(unlatex(s))}</>;
}

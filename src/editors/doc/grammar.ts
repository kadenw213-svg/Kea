import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { setting } from '../../lib/settings';

/**
 * Offline grammar and style checking with Harper (runs entirely on this computer, in WebAssembly).
 * Each paragraph is checked separately and re-checked only when it changes. Problems get a blue wavy
 * underline; clicking one shows the explanation and one-click fixes.
 */

export interface GrammarIssue {
  from: number;
  to: number;
  kind: string;
  message: string;
  suggestions: { kind: 'replace' | 'remove' | 'insert'; text: string }[];
}

interface GState {
  issues: GrammarIssue[];
  decos: DecorationSet;
}

export const grammarKey = new PluginKey<GState>('grammar');

// ---------- Harper (loaded on first use) ----------
let linterPromise: Promise<any> | null = null;
let appliedDialect: string | null = null;
async function linter() {
  if (!linterPromise) {
    linterPromise = (async () => {
      const [{ LocalLinter, Dialect }, { binary }] = await Promise.all([import('harper.js'), import('harper.js/binary')]);
      const l = new LocalLinter({ binary, dialect: Dialect.American });
      await l.setup();
      return { l, Dialect };
    })();
  }
  const h = await linterPromise;
  const want = setting<string>('grammar.dialect') || 'American';
  if (appliedDialect !== want) {
    appliedDialect = want;
    await h.l.setDialect((h.Dialect as any)[want] ?? h.Dialect.American);
  }
  return h.l;
}

const CATEGORY: Record<string, string> = {
  Spelling: 'grammar.spelling',
  Typo: 'grammar.spelling',
  Style: 'grammar.style',
  Readability: 'grammar.style',
  Enhancement: 'grammar.style',
  Redundancy: 'grammar.style',
  Repetition: 'grammar.style',
  WordChoice: 'grammar.style',
  Regionalism: 'grammar.style',
  Capitalization: 'grammar.capitalization',
  Punctuation: 'grammar.punctuation',
  Formatting: 'grammar.punctuation'
};
const enabledKind = (kind: string) => {
  const key = CATEGORY[kind];
  return key ? setting(key) !== false : true;
};

/** A paragraph's text with a map from each UTF-16 index to its document position. */
function blockText(node: PMNode, start: number) {
  let text = '';
  const map: number[] = [];
  node.forEach((child, offset) => {
    const pos = start + 1 + offset;
    if (child.isText) {
      // Skip text suggested for deletion; it isn't really there.
      if (child.marks.some((m) => m.type.name === 'deletion')) return;
      const t = child.text || '';
      for (let i = 0; i < t.length; i++) map.push(pos + i);
      text += t;
    } else {
      // Footnotes, citations and breaks read as a space.
      map.push(pos);
      text += child.type.name === 'hardBreak' ? '\n' : ' ';
    }
  });
  map.push(start + node.nodeSize - 1);
  return { text, map };
}

/** Harper counts characters (code points); JS strings count UTF-16 units. */
function cpToUtf16(text: string) {
  const out: number[] = [];
  let u = 0;
  for (const ch of text) {
    out.push(u);
    u += ch.length;
  }
  out.push(u);
  return out;
}

type Found = Omit<GrammarIssue, 'from' | 'to'> & { s: number; e: number };
const cache = new Map<string, Found[]>();
const ignored = new Set<string>();
const issueKey = (text: string, i: { s: number; e: number; message: string }) => `${text.slice(i.s, i.e)}|${i.message}`;

async function lintBlock(text: string) {
  const hit = cache.get(text);
  if (hit) return hit;
  const l = await linter();
  const lints = await l.lint(text, { language: 'plaintext' });
  const conv = cpToUtf16(text);
  const out = lints.map((lint: any) => {
    const span = lint.span();
    const res = {
      s: conv[span.start] ?? span.start,
      e: conv[span.end] ?? span.end,
      kind: lint.lint_kind(),
      message: lint.message(),
      suggestions: lint
        .suggestions()
        .map((sg: any) => {
          const k = sg.kind();
          return { kind: k === 1 ? 'remove' : k === 2 ? 'insert' : 'replace', text: sg.get_replacement_text() } as GrammarIssue['suggestions'][number];
        })
        .filter((sg: GrammarIssue['suggestions'][number], i: number, all: GrammarIssue['suggestions']) => all.findIndex((x) => x.kind === sg.kind && x.text === sg.text) === i)
    };
    lint.free?.();
    return res;
  });
  if (cache.size > 3000) cache.clear();
  cache.set(text, out as Found[]);
  return out as Found[];
}

function textBlocks(state: EditorState) {
  const blocks: { node: PMNode; pos: number }[] = [];
  state.doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (node.type.name !== 'codeBlock' && node.textContent.trim()) blocks.push({ node, pos });
      return false;
    }
    return true;
  });
  return blocks;
}

async function checkAll(view: EditorView, isCurrent: () => boolean) {
  const state = view.state;
  const issues: GrammarIssue[] = [];
  const blocks = textBlocks(state);
  let lastYield = performance.now();
  for (const { node, pos } of blocks) {
    const { text, map } = blockText(node, pos);
    const found = await lintBlock(text);
    for (const f of found) {
      if (!enabledKind(f.kind) || ignored.has(issueKey(text, f))) continue;
      const from = map[f.s];
      const to = map[Math.min(f.e, map.length - 1)] ?? map[map.length - 1];
      if (from == null || to == null || to <= from) continue;
      issues.push({ from, to: f.e >= text.length ? map[map.length - 1] : to, kind: f.kind, message: f.message, suggestions: f.suggestions });
    }
    // Keep typing smooth on long documents.
    if (performance.now() - lastYield > 12) {
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
      if (!isCurrent()) return null;
    }
  }
  return isCurrent() ? issues : null;
}

export const Grammar = Extension.create<{}, { onIssueClick: (issue: GrammarIssue, rect: DOMRect) => void; enabled: () => boolean }>({
  name: 'grammar',
  addStorage() {
    return { onIssueClick: () => {}, enabled: () => true };
  },
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin<GState>({
        key: grammarKey,
        state: {
          init: () => ({ issues: [], decos: DecorationSet.empty }),
          apply(tr, v, _old, state) {
            const m = tr.getMeta(grammarKey);
            if (m) {
              const decos = DecorationSet.create(
                state.doc,
                m.issues.map((i: GrammarIssue, idx: number) => Decoration.inline(i.from, i.to, { class: `gr-err gr-${i.kind.toLowerCase()}`, 'data-gr': String(idx) }))
              );
              return { issues: m.issues, decos };
            }
            if (!tr.docChanged) return v;
            return {
              issues: v.issues.map((i) => ({ ...i, from: tr.mapping.map(i.from), to: tr.mapping.map(i.to, -1) })).filter((i) => i.to > i.from),
              decos: v.decos.map(tr.mapping, tr.doc)
            };
          }
        },
        props: {
          decorations(state) {
            return grammarKey.getState(state)?.decos;
          },
          handleClick(view, pos, event) {
            const el = (event.target as HTMLElement).closest?.('.gr-err') as HTMLElement | null;
            if (!el) return false;
            const st = grammarKey.getState(view.state);
            const issue = st?.issues.find((i) => pos >= i.from && pos <= i.to);
            if (!issue) return false;
            storage.onIssueClick(issue, el.getBoundingClientRect());
            return false;
          }
        },
        view(view) {
          let timer: any = null;
          let run = 0;
          const schedule = (delay = 600) => {
            clearTimeout(timer);
            timer = setTimeout(async () => {
              const id = ++run;
              if (!storage.enabled() || setting('grammar.enabled') === false) {
                if (grammarKey.getState(view.state)?.issues.length) view.dispatch(view.state.tr.setMeta(grammarKey, { issues: [] }).setMeta('addToHistory', false));
                return;
              }
              try {
                const doc = view.state.doc;
                const issues = await checkAll(view, () => id === run && view.state.doc === doc && !view.isDestroyed);
                if (issues) view.dispatch(view.state.tr.setMeta(grammarKey, { issues }).setMeta('addToHistory', false));
              } catch (err) {
                console.warn('grammar check failed', err);
              }
            }, delay);
          };
          // Load Harper a moment after the document opens, not during startup.
          schedule(1500);
          (view as any).__grammarRecheck = () => schedule(0);
          return {
            update(v, prev) {
              if (v.state.doc !== prev.doc) schedule();
            },
            destroy() {
              clearTimeout(timer);
              run++;
            }
          };
        }
      })
    ];
  }
});

/** Apply one of an issue's fixes. */
export function applyFix(view: EditorView, issue: GrammarIssue, fix: GrammarIssue['suggestions'][number]) {
  const tr = view.state.tr;
  if (fix.kind === 'remove') tr.delete(issue.from, issue.to);
  else if (fix.kind === 'insert') tr.insertText(fix.text, issue.to);
  else tr.insertText(fix.text, issue.from, issue.to);
  view.dispatch(tr);
  view.focus();
}

/** Stop flagging this exact problem (for this session). */
export function ignoreIssue(view: EditorView, issue: GrammarIssue) {
  const $p = view.state.doc.resolve(issue.from);
  const block = $p.parent;
  const start = $p.before();
  const { text, map } = blockText(block, start);
  const s = map.indexOf(issue.from);
  const e = map.indexOf(issue.to);
  if (s >= 0) ignored.add(`${text.slice(s, e >= 0 ? e : undefined)}|${issue.message}`);
  (view as any).__grammarRecheck?.();
}

export function recheckGrammar(view: EditorView) {
  (view as any).__grammarRecheck?.();
}

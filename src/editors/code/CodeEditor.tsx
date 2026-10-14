import { useEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting, indentUnit } from '@codemirror/language';
import { useSetting } from '../../lib/settings';
import { openSearchPanel } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { xml } from '@codemirror/lang-xml';
import { Save, Search, WrapText, Minus, Plus, MoreVertical, Printer, Undo2, Redo2 } from 'lucide-react';
import { undo, redo } from '@codemirror/commands';
import type { Tab } from '../../store';
import { editorRegistry, setDirty } from '../../store';
import { bytesToText, escapeHtml, clamp } from '../../lib/util';
import { saveTabFile } from '../../lib/save';
import { extOf, baseName } from '../../lib/fileTypes';
import { api } from '../../lib/api';
import { MenuButton } from '../../components/Popover';
import './code.css';
import { AiButton } from '../../components/ai/AiButton';
import { publishSelection } from '../../components/ai/aiStore';
import { proxyAi, AiHooks } from '../../store';

const LANGS: Record<string, { name: string; ext: () => any }> = {
  js: { name: 'JavaScript', ext: () => javascript() },
  mjs: { name: 'JavaScript', ext: () => javascript() },
  cjs: { name: 'JavaScript', ext: () => javascript() },
  jsx: { name: 'JavaScript (JSX)', ext: () => javascript({ jsx: true }) },
  ts: { name: 'TypeScript', ext: () => javascript({ typescript: true }) },
  tsx: { name: 'TypeScript (TSX)', ext: () => javascript({ typescript: true, jsx: true }) },
  json: { name: 'JSON', ext: () => json() },
  html: { name: 'HTML', ext: () => html() },
  htm: { name: 'HTML', ext: () => html() },
  css: { name: 'CSS', ext: () => css() },
  md: { name: 'Markdown', ext: () => markdown() },
  markdown: { name: 'Markdown', ext: () => markdown() },
  py: { name: 'Python', ext: () => python() },
  xml: { name: 'XML', ext: () => xml() },
  svg: { name: 'SVG', ext: () => xml() },
  csproj: { name: 'XML', ext: () => xml() }
};

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: '#c58af9' },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: '#e3e3e3' },
  { tag: [t.function(t.variableName), t.labelName], color: '#8ab4f8' },
  { tag: [t.propertyName], color: '#a8c7fa' },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: '#f6b26b' },
  { tag: [t.definition(t.name), t.separator], color: '#e3e3e3' },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace], color: '#fdd663' },
  { tag: [t.operator, t.operatorKeyword, t.url, t.escape, t.regexp, t.special(t.string)], color: '#78d9ec' },
  { tag: [t.meta, t.comment], color: '#8e918f', fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: '#8ab4f8', textDecoration: 'underline' },
  { tag: t.heading, fontWeight: 'bold', color: '#8ab4f8' },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: '#f28b82' },
  { tag: [t.processingInstruction, t.string, t.inserted], color: '#81c995' },
  { tag: t.invalid, color: '#f28b82' },
  { tag: t.tagName, color: '#f28b82' },
  { tag: t.attributeName, color: '#fdd663' }
]);

const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'transparent', color: '#e3e3e3' },
    '.cm-content': { caretColor: '#a8c7fa', fontFamily: 'Consolas, "Cascadia Code", "Courier New", monospace', padding: '12px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#a8c7fa', borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'rgba(124,172,248,0.28) !important' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#5f6368', border: 'none', paddingRight: '8px' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#c4c7c5' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.035)' },
    '.cm-foldPlaceholder': { backgroundColor: '#36373a', border: 'none', color: '#c4c7c5' },
    '.cm-tooltip': { border: 'none', backgroundColor: '#2c2d30', borderRadius: '8px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'rgba(168,199,250,0.18)', color: '#e3e3e3' },
    '.cm-panels': { backgroundColor: '#232426', color: '#e3e3e3', borderTop: 'none' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid #2e3033' },
    '.cm-panel.cm-search': { padding: '8px 12px', fontFamily: 'Inter, Segoe UI, sans-serif' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontFamily: 'inherit' },
    '.cm-textfield': { backgroundColor: '#1b1c1d', border: '1px solid #444649', borderRadius: '6px', color: '#e3e3e3', padding: '4px 8px' },
    '.cm-button': { backgroundImage: 'none', backgroundColor: '#36373a', border: 'none', borderRadius: '6px', color: '#e3e3e3', padding: '4px 10px' },
    '.cm-searchMatch': { backgroundColor: 'rgba(253,214,99,0.3)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(255,145,0,0.55)' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(168,199,250,0.12)' },
    '.cm-matchingBracket': { backgroundColor: 'rgba(129,201,149,0.25)', outline: 'none' }
  },
  { dark: true }
);

export default function CodeEditor({ tab, active }: { tab: Tab; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapComp = useRef(new Compartment());
  const sizeComp = useRef(new Compartment());
  const prefsComp = useRef(new Compartment());
  const lineNumbers = useSetting<boolean>('code.lineNumbers');
  const tabSize = Number(useSetting('code.tabSize')) || 2;
  const codeFont = useSetting<string>('code.font');
  const highlightLine = useSetting<boolean>('code.highlightLine');
  const defaultWrap = useSetting<boolean>('code.wrap');
  const defaultSize = Number(useSetting('code.fontSize')) || 14;
  const prefs = () => [
    EditorState.tabSize.of(tabSize),
    indentUnit.of(' '.repeat(tabSize)),
    EditorView.theme({
      '.cm-content, .cm-gutters': { fontFamily: codeFont },
      ...(lineNumbers ? {} : { '.cm-lineNumbers': { display: 'none' } }),
      ...(highlightLine ? {} : { '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' } })
    })
  ];
  const meta = useRef({ eol: '\n', bom: false });
  const [wrap, setWrap] = useState(defaultWrap);
  const [fontSize, setFontSize] = useState(defaultSize);
  useEffect(() => setWrap(defaultWrap), [defaultWrap]);
  useEffect(() => setFontSize(defaultSize), [defaultSize]);
  const [pos, setPos] = useState({ line: 1, col: 1, sel: 0, lines: 1 });
  const ext = extOf(tab.name);
  const lang = LANGS[ext];

  useEffect(() => {
    let text = '';
    if (tab.data) {
      meta.current.bom = tab.data[0] === 0xef && tab.data[1] === 0xbb && tab.data[2] === 0xbf;
      text = bytesToText(tab.data);
      meta.current.eol = /\r\n/.test(text.slice(0, 10000)) ? '\r\n' : '\n';
    } else meta.current.eol = window.api?.platform === 'win32' ? '\r\n' : '\n';
    const state = EditorState.create({
      doc: text.replace(/\r\n?/g, '\n'),
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        theme,
        syntaxHighlighting(highlight),
        wrapComp.current.of(wrap ? EditorView.lineWrapping : []),
        prefsComp.current.of(prefs()),
        sizeComp.current.of(EditorView.theme({ '.cm-content, .cm-gutters': { fontSize: `${fontSize}px` } })),
        lang ? lang.ext() : [],
        EditorView.updateListener.of((u) => {
          if (u.docChanged) setDirty(tab.id, true);
          if (u.selectionSet) {
            const m = u.state.selection.main;
            if (m.to > m.from) publishSelection(tab.id, u.state.sliceDoc(m.from, m.to));
          }
          if (u.docChanged || u.selectionSet) {
            const s = u.state.selection.main;
            const line = u.state.doc.lineAt(s.head);
            setPos({ line: line.number, col: s.head - line.from + 1, sel: Math.abs(s.to - s.from), lines: u.state.doc.lines });
          }
        })
      ]
    });
    const view = new EditorView({ state, parent: hostRef.current! });
    viewRef.current = view;
    setPos((p) => ({ ...p, lines: state.doc.lines }));
    return () => view.destroy();
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: wrapComp.current.reconfigure(wrap ? EditorView.lineWrapping : []) });
  }, [wrap]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: prefsComp.current.reconfigure(prefs()) });
  }, [lineNumbers, tabSize, codeFont, highlightLine]);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: sizeComp.current.reconfigure(EditorView.theme({ '.cm-content, .cm-gutters': { fontSize: `${fontSize}px` } })) });
  }, [fontSize]);

  useEffect(() => {
    if (active) setTimeout(() => viewRef.current?.focus(), 0);
  }, [active]);

  const build = async () => {
    const text = viewRef.current!.state.doc.toString().replace(/\n/g, meta.current.eol);
    const body = new TextEncoder().encode(text);
    if (!meta.current.bom) return body;
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  };
  const save = (saveAs: boolean) => {
    const e = tab.path ? extOf(tab.path) : ext || 'txt';
    return saveTabFile(
      tab.id,
      [
        { name: lang?.name || 'Text file', ext: e || 'txt', build },
        ...(e !== 'txt' ? [{ name: 'Text file', ext: 'txt', build }] : []),
        ...(e !== 'md' ? [{ name: 'Markdown', ext: 'md', build }] : [])
      ],
      saveAs
    );
  };
  const print = async () => {
    const text = viewRef.current!.state.doc.toString();
    await api.printHtml(
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(tab.name)}</title><style>@page{margin:0.6in}body{margin:0}pre{font:10pt Consolas,'Courier New',monospace;white-space:pre-wrap;word-break:break-word}</style></head><body><pre>${escapeHtml(text)}</pre></body></html>`
    );
  };
  const aiRef = useRef<AiHooks>(null as any);
  aiRef.current = {
    noun: 'file',
    insertLabel: 'Insert below',
    async getDocument() {
      const v = viewRef.current;
      const text = v ? v.state.doc.toString() : '';
      const lines = text.split('\n');
      const sections: { id: string; label: string; text: string }[] = [];
      for (let i = 0; i < lines.length; i += 60) sections.push({ id: `l${i + 1}`, label: `Lines ${i + 1}–${Math.min(lines.length, i + 60)}`, text: lines.slice(i, i + 60).join('\n') });
      return { full: text, sections };
    },
    replaceSelection(text) {
      const v = viewRef.current;
      const m = v?.state.selection.main;
      if (!v || !m || m.from === m.to) return false;
      v.dispatch({ changes: { from: m.from, to: m.to, insert: text }, selection: { anchor: m.from + text.length } });
      v.focus();
      return true;
    },
    insertText(text) {
      const v = viewRef.current;
      if (!v) return false;
      const line = v.state.doc.lineAt(v.state.selection.main.to);
      const insert = '\n' + text;
      v.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length } });
      v.focus();
      return true;
    },
    reveal(quote) {
      const v = viewRef.current;
      if (!v) return false;
      const doc = v.state.doc.toString();
      const q = quote.trim().slice(0, 80);
      let i = doc.indexOf(q);
      if (i < 0) i = doc.toLowerCase().indexOf(q.toLowerCase());
      if (i < 0) return false;
      v.dispatch({ selection: { anchor: i, head: i + q.length }, scrollIntoView: true });
      v.focus();
      return true;
    },
    replaceQuote(quote, replacement) {
      const v = viewRef.current;
      if (!v) return false;
      const i = v.state.doc.toString().indexOf(quote);
      if (i < 0) return false;
      v.dispatch({ changes: { from: i, to: i + quote.length, insert: replacement } });
      return true;
    }
  };
  const handlers = useRef({ save, print });
  handlers.current = { save, print };
  useEffect(() => {
    editorRegistry.set(tab.id, { save: (a) => handlers.current.save(a), print: () => handlers.current.print(), debugBuild: () => build(), ai: proxyAi(aiRef) });
  }, [tab.id]);

  const cmd = (fn: (v: EditorView) => boolean) => {
    const v = viewRef.current;
    if (v) {
      fn(v);
      v.focus();
    }
  };

  return (
    <div className="code-editor">
      <div className="toolbar">
        <button className="icon-btn" title="Undo (Ctrl+Z)" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd(undo)}>
          <Undo2 size={18} />
        </button>
        <button className="icon-btn" title="Redo (Ctrl+Y)" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd(redo)}>
          <Redo2 size={18} />
        </button>
        <div className="tb-sep" />
        <button className="icon-btn" title="Find and replace (Ctrl+F)" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd(openSearchPanel)}>
          <Search size={18} />
        </button>
        <button className={`icon-btn ${wrap ? 'active' : ''}`} title="Word wrap" onClick={() => setWrap((w) => !w)}>
          <WrapText size={18} />
        </button>
        <div className="tb-sep" />
        <button className="icon-btn" title="Smaller text" onClick={() => setFontSize((s) => clamp(s - 1, 9, 32))}>
          <Minus size={16} />
        </button>
        <span className="tb-label">{fontSize}px</span>
        <button className="icon-btn" title="Larger text" onClick={() => setFontSize((s) => clamp(s + 1, 9, 32))}>
          <Plus size={16} />
        </button>
        <div className="tb-spacer" />
        <div className="tb-end">
        <AiButton />
        <button className="btn primary sm" onMouseDown={(e) => e.preventDefault()} onClick={() => save(false)} title="Save (Ctrl+S)">
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
              <button className="menu-item" onClick={() => (print(), close())}>
                <Printer size={16} /> Print… <span className="kbd">Ctrl+P</span>
              </button>
            </>
          )}
        </MenuButton>
        </div>
      </div>
      <div className="code-host" ref={hostRef} />
      <div className="statusbar">
        <span>
          Ln {pos.line}, Col {pos.col}
          {pos.sel ? ` (${pos.sel} selected)` : ''}
        </span>
        <span>{pos.lines.toLocaleString()} lines</span>
        <span className="grow" />
        <span>{lang?.name || (ext ? ext.toUpperCase() : 'Plain text')}</span>
        <span>{meta.current.eol === '\r\n' ? 'CRLF' : 'LF'}</span>
        <span>UTF-8{meta.current.bom ? ' BOM' : ''}</span>
        <span title={baseName(tab.name)} />
      </div>
    </div>
  );
}

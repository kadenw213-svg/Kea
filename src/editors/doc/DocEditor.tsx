import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import FontFamily from '@tiptap/extension-font-family';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import {
  Undo2,
  Redo2,
  Bold,
  Italic,
  Underline as UIcon,
  Strikethrough,
  Baseline,
  Highlighter,
  Link2,
  ImagePlus,
  Table2,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  List,
  ListOrdered,
  ListChecks,
  IndentDecrease,
  IndentIncrease,
  RemoveFormatting,
  Search,
  Sun,
  Moon,
  Save,
  MoreVertical,
  FileDown,
  Printer,
  Minus,
  Plus,
  SeparatorHorizontal,
  FileText,
  Code2,
  Quote,
  Superscript as SupIcon,
  Subscript as SubIcon,
  ChevronUp,
  ChevronDown,
  X,
  Trash2,
  Rows3,
  Columns3,
  TableCellsMerge,
  TableCellsSplit,
  Heading,
  ArrowUpToLine,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  WrapText,
  FileCog,
  PanelTop,
  Asterisk,
  CalendarDays,
  PlusSquare,
  Quote as QuoteIcon,
  BookOpen,
  ListTree,
  Maximize2,
  Target
} from 'lucide-react';
import type { Tab } from '../../store';
import { editorRegistry, setDirty, toast, prompt, useTabs } from '../../store';
import { FontSize, ParagraphFormat, PageBreak, ResizableImage, Search as SearchExt, searchKey, cleanPastedHtml } from './extensions';
import { docxToDoc } from './docxImport';
import { Footnote, Pagination, pageGroups, hfHtml, footnotesOf } from './pagination';
import { DocMeta, defaultMeta, pageBox, hfFor, cssLineHeight, PAGE_SIZES } from './docMeta';
import { PageSetupDialog, HeaderFooterDialog } from './DocDialogs';
import { setting, useSetting } from '../../lib/settings';
import { DOMSerializer } from '@tiptap/pm/model';
import { Citation, Bibliography, refreshCitations } from './citations';
import { CitationsDialog, CiteTarget } from './CitationsDialog';
import { TableOfContents, refreshToc } from './toc';
import { paginationKey } from './pagination';
import { odtToHtml, rtfToHtml, docToHtml } from './otherFormats';
import { jsonToDocx } from './docxExport';
import { saveTabFile, exportFile, SaveFormat } from '../../lib/save';
import { extOf, baseName } from '../../lib/fileTypes';
import { bytesToText, textToBytes, bytesToDataUrl, escapeHtml, modKey, clamp } from '../../lib/util';
import { api } from '../../lib/api';
import { MenuButton } from '../../components/Popover';
import { ColorPicker } from '../../components/ColorPicker';
import { mimeFor } from '../../lib/pdfTools';
import './doc.css';
import { docAiHooks } from './aiHooks';
import { AiButton } from '../../components/ai/AiButton';
import { publishSelection } from '../../components/ai/aiStore';

const FONTS = ['Arial', 'Calibri', 'Cambria', 'Georgia', 'Garamond', 'Segoe UI', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Courier New', 'Consolas', 'Comic Sans MS'];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];
const BLOCK_SIZE: Record<string, number> = { h1: 20, h2: 16, h3: 14, h4: 12, p: 11 };

/** Settings for a brand-new document, from Settings → Documents. */
export function newDocMeta(): DocMeta {
  const size = PAGE_SIZES[setting<string>('doc.pageSize')] || PAGE_SIZES.letter;
  const mg = Number(setting('doc.margin')) || 1;
  const base = defaultMeta();
  return defaultMeta({
    page: { ...base.page, size: (setting<string>('doc.pageSize') as any) || 'letter', width: size.w, height: size.h, margins: { top: mg, right: mg, bottom: mg, left: mg } },
    defaults: {
      font: setting<string>('doc.font') || 'Arial',
      sizePt: Number(setting('doc.size')) || 11,
      lineHeight: Number(setting('doc.lineHeight')) || 1.15,
      spaceAfterPt: Number(setting('doc.spaceAfter')) ?? 6,
      firstLineIn: Number(setting('doc.firstLine')) || 0
    },
    citationStyle: (setting<string>('doc.citationStyle') as any) || 'mla',
    pageless: !!setting('doc.pageless')
  });
}

/** Slate settings embedded in .html files saved by Slate. */
function metaFromHtml(text: string): DocMeta | null {
  const m = /<meta name="slate-doc" content="([^"]+)"/.exec(text);
  if (!m) return null;
  try {
    return { ...newDocMeta(), ...JSON.parse(decodeURIComponent(escape(atob(m[1])))) };
  } catch {
    return null;
  }
}

export default function DocEditor({ tab, active }: { tab: Tab; active: boolean }) {
  const [html, setHtmlState] = useState<string | null>(null);
  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [error, setError] = useState('');
  const setHtml = (h: string, m?: DocMeta | null) => {
    setMeta(m || newDocMeta());
    setHtmlState(h);
  };

  useEffect(() => {
    (async () => {
      try {
        if (!tab.data) return setHtml('');
        const ext = extOf(tab.name);
        const head = bytesToText(tab.data.subarray(0, 8));
        const isZip = tab.data[0] === 0x50 && tab.data[1] === 0x4b;
        if ((ext === 'docx' || ext === 'docm' || ext === 'dotx') && isZip) {
          const d = await docxToDoc(tab.data);
          setHtml(d.html, d.meta);
        }
        else if (ext === 'odt') setHtml(await odtToHtml(tab.data));
        else if (ext === 'rtf' || head.startsWith('{\\rtf')) setHtml(rtfToHtml(bytesToText(tab.data)));
        else if (ext === 'doc' && tab.data[0] === 0xd0 && tab.data[1] === 0xcf) {
          setHtml(docToHtml(tab.data));
          toast('Opened an old Word file. All text is kept; some formatting may be simplified. Saving creates a .docx.');
        } else {
          const text = bytesToText(tab.data);
          const body = new DOMParser().parseFromString(text, 'text/html').body;
          body.querySelectorAll('script, style, iframe, object, embed').forEach((n) => n.remove());
          const own = metaFromHtml(text);
          // Slate's own files and templates keep their blank lines; other HTML gets tidied like a paste.
          setHtml(own ? body.innerHTML : cleanPastedHtml(body.innerHTML), own);
        }
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
          <h3 style={{ color: 'var(--text)', fontWeight: 500 }}>Couldn't open this document</h3>
          <p>{error}</p>
        </div>
      </div>
    );
  if (html === null || !meta)
    return (
      <div className="center-fill">
        <div className="spinner" />
      </div>
    );
  return <DocEditorInner tab={tab} active={active} initialHtml={html} initialMeta={meta} />;
}

function DocEditorInner({ tab, active, initialHtml, initialMeta }: { tab: Tab; active: boolean; initialHtml: string; initialMeta: DocMeta }) {
  const paperSetting = useSetting<'dark' | 'light'>('doc.paper');
  const [paper, setPaper] = useState<'dark' | 'light'>(paperSetting);
  useEffect(() => setPaper(paperSetting), [paperSetting]);
  const [zoom, setZoom] = useState(() => Number(setting('doc.zoom')) || 1);
  const [meta, setMetaState] = useState<DocMeta>(initialMeta);
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const [pages, setPages] = useState(1);
  const [dialog, setDialog] = useState<null | 'page' | 'hf' | 'cite'>(null);
  const [citeTarget, setCiteTarget] = useState<CiteTarget | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [selWords, setSelWords] = useState(0);
  const showHints = useSetting<boolean>('doc.statusHints');
  const userName = useSetting<string>('user.name');
  const updateMeta = (m: DocMeta) => {
    metaRef.current = m;
    setMetaState(m);
    setDirty(tab.id, true);
    setTimeout(() => {
      const ed = editorRef.current;
      if (!ed) return;
      refreshCitations(ed, m);
      ed.commands.relayout();
    }, 0);
  };
  const [findOpen, setFindOpen] = useState<false | 'find' | 'replace'>(false);
  const [counts, setCounts] = useState({ words: 0, chars: 0 });

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
      Underline,
      TextStyle,
      Color,
      FontFamily,
      FontSize,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: null } }),
      Placeholder.configure({ placeholder: 'Start typing…' }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Subscript,
      Superscript,
      ParagraphFormat,
      PageBreak,
      ResizableImage,
      SearchExt,
      Footnote,
      Pagination,
      Citation,
      Bibliography,
      TableOfContents
    ],
    content: initialHtml,
    autofocus: initialHtml ? false : 'start',
    editorProps: {
      attributes: { class: 'doc-content', spellcheck: 'true' },
      transformPastedHTML: cleanPastedHtml,
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        files.forEach(async (f) => {
          const url = await bytesToDataUrl(new Uint8Array(await f.arrayBuffer()), f.type);
          editorRef.current?.chain().focus().setImage({ src: url }).run();
        });
        return true;
      },
      handleDrop: (view, event) => {
        const files = Array.from(event.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        files.forEach(async (f) => {
          const url = await bytesToDataUrl(new Uint8Array(await f.arrayBuffer()), f.type);
          const chain = editorRef.current!.chain().focus();
          if (pos != null) chain.setTextSelection(pos);
          chain.setImage({ src: url }).run();
        });
        return true;
      }
    },
    onUpdate: ({ editor }) => {
      setDirty(tab.id, true);
      scheduleCount(editor);
    }
  });
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  // Connect page layout, footnote editing and header/footer clicks to this document.
  useEffect(() => {
    if (!editor) return;
    const st = editor.storage as any;
    st.pagination.input = () => ({ meta: metaRef.current, title: baseName(tab.name), author: setting('user.name') });
    st.pagination.onHF = () => setDialog('hf');
    st.pagination.onPages = (n: number) => setPages(n);
    st.footnote.onEdit = async (pos: number, text: string) => {
      const v = await prompt('Footnote', 'Shown at the bottom of the page, numbered automatically.', text, 'e.g. Smith, A History of Rome, 45.');
      const ed = editorRef.current;
      if (!ed) return;
      const node = ed.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'footnote') return;
      if (v === null) {
        if (!text) ed.view.dispatch(ed.state.tr.delete(pos, pos + 1));
      } else if (v !== text) ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, undefined, { text: v }));
      ed.commands.focus();
    };
    st.citation.onEdit = (pos: number) => {
      const node = editorRef.current?.state.doc.nodeAt(pos);
      if (!node || node.type.name !== 'citation') return;
      setCiteTarget({ pos, ids: node.attrs.ids || [], page: node.attrs.page || '' });
      setDialog('cite');
    };
    refreshCitations(editor, metaRef.current);
    editor.commands.relayout();
    // Tables of contents follow page layout; citations follow edits.
    const onTr = ({ transaction }: any) => {
      if (transaction.getMeta(paginationKey)?.layout) refreshToc(editor, metaRef.current.pageNumberStart || 1);
    };
    editor.on('transaction', onTr);
    return () => {
      editor.off('transaction', onTr);
    };
  }, [editor]);
  useEffect(() => {
    editorRef.current?.commands.relayout();
  }, [tab.name]);

  const countTimer = useRef<any>(null);
  const scheduleCount = (ed: Editor) => {
    clearTimeout(countTimer.current);
    countTimer.current = setTimeout(() => {
      const text = ed.state.doc.textBetween(0, ed.state.doc.content.size, ' ', ' ');
      setCounts({ words: (text.match(/\S+/g) || []).length, chars: text.replace(/\s/g, '').length });
    }, 250);
  };
  useEffect(() => {
    if (editor) scheduleCount(editor);
  }, [editor]);


  // ---------- Save / export ----------
  const formats = (): SaveFormat[] => {
    const docx: SaveFormat = { name: 'Word document', ext: 'docx', build: () => jsonToDocx(editor!.getJSON() as any, metaRef.current, baseName(tab.name)) };
    const html: SaveFormat = { name: 'Web page', ext: 'html', build: async () => textToBytes(printableHtml(editor!, tab.name, false, metaRef.current)) };
    const ext = tab.path ? extOf(tab.path) : '';
    return ext === 'html' || ext === 'htm' ? [{ ...html, ext }, docx] : [docx, html];
  };

  const save = (saveAs: boolean) => saveTabFile(tab.id, formats(), saveAs);

  const exportPdf = () =>
    exportFile(`${baseName(tab.name)}.pdf`, {
      name: 'PDF',
      ext: 'pdf',
      build: () => api.pdfFromHtml(printableHtml(editor!, tab.name, true, metaRef.current), { noMargins: !metaRef.current.pageless })
    });
  const exportText = () =>
    exportFile(`${baseName(tab.name)}.txt`, {
      name: 'Plain text',
      ext: 'txt',
      build: async () => textToBytes(editor!.getText({ blockSeparator: '\n\n' }))
    });
  const exportHtml = () =>
    exportFile(`${baseName(tab.name)}.html`, { name: 'Web page', ext: 'html', build: async () => textToBytes(printableHtml(editor!, tab.name, false, metaRef.current)) });
  const print = async () => {
    await api.printHtml(printableHtml(editor!, tab.name, true, metaRef.current), { noMargins: !metaRef.current.pageless });
  };

  const handlers = useRef({ save, print, exportPdf });
  handlers.current = { save, print, exportPdf };
  useEffect(() => {
    editorRegistry.set(tab.id, {
      save: (a) => handlers.current.save(a),
      print: () => handlers.current.print(),
      exportPdf: async () => void (await handlers.current.exportPdf()),
      debugPdf: () => {
        const name = useTabs.getState().tabs.find((t) => t.id === tab.id)?.name || '';
        return api.pdfFromHtml(printableHtml(editorRef.current!, name, true, metaRef.current), { noMargins: !metaRef.current.pageless });
      },
      debugBuild: () => jsonToDocx(editorRef.current!.getJSON() as any, metaRef.current, baseName(useTabs.getState().tabs.find((t) => t.id === tab.id)?.name || '')),
      ai: docAiHooks(() => editorRef.current)
    });
  }, [tab.id]);

  // Report highlighted text to the AI sidebar.
  useEffect(() => {
    if (!editor) return;
    const onSel = () => {
      const { from, to } = editor.state.selection;
      if (to > from) publishSelection(tab.id, editor.state.doc.textBetween(from, to, '\n', ' '));
      setSelWords(to > from ? (editor.state.doc.textBetween(from, to, ' ', ' ').match(/\S+/g) || []).length : 0);
    };
    editor.on('selectionUpdate', onSel);
    return () => {
      editor.off('selectionUpdate', onSel);
    };
  }, [editor])

  // ---------- Shortcuts ----------
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && focusMode) {
        setFocusMode(false);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        return;
      }
      if (!modKey(e)) return;
      const k = e.key.toLowerCase();
      if (k === 'c' && e.altKey) {
        e.preventDefault();
        setCiteTarget(null);
        setDialog('cite');
        return;
      }
      if (k === 'f') {
        e.preventDefault();
        setFindOpen('find');
      } else if (k === 'h') {
        e.preventDefault();
        setFindOpen('replace');
      } else if (k === 'k') {
        e.preventDefault();
        setLink();
      } else if (k === '=' || k === '+') {
        e.preventDefault();
        setZoom((z) => clamp(Math.round((z + 0.1) * 10) / 10, 0.5, 2.5));
      } else if (k === '-') {
        e.preventDefault();
        setZoom((z) => clamp(Math.round((z - 0.1) * 10) / 10, 0.5, 2.5));
      } else if (k === '0') {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (active && editor && !editor.isFocused) setTimeout(() => editor.commands.focus(), 0);
  }, [active, editor]);

  const setLink = async () => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href || '';
    const url = await prompt(prev ? 'Edit link' : 'Insert link', 'Web address', prev, 'https://');
    if (url === null) return editor.commands.focus();
    if (!url.trim()) return editor.chain().focus().extendMarkRange('link').unsetLink().run();
    const href = /^(https?:|mailto:|#)/i.test(url) ? url : `https://${url}`;
    if (editor.state.selection.empty && !editor.isActive('link')) {
      editor.chain().focus().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href } }] }).run();
    } else editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  };

  const insertImage = async () => {
    const [f] = await api.openDialog({ title: 'Insert image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }] });
    if (!f || !editor) return;
    editor.chain().focus().setImage({ src: await bytesToDataUrl(f.data, mimeFor(f.name)) }).run();
  };

  if (!editor) return null;
  const box = pageBox(meta);
  const D = meta.defaults;
  const pageVars = {
    zoom,
    width: box.w,
    padding: meta.pageless ? `${box.mt}px ${box.mr}px ${box.mb}px ${box.ml}px` : `${box.mt}px ${box.mr}px 0 ${box.ml}px`,
    minHeight: meta.pageless ? box.h : undefined,
    ['--doc-font' as any]: `'${D.font}', Arial, sans-serif`,
    ['--doc-size' as any]: `${D.sizePt}pt`,
    ['--doc-lh' as any]: String(cssLineHeight(D.lineHeight)),
    ['--doc-after' as any]: `${D.spaceAfterPt}pt`,
    ['--doc-first' as any]: `${D.firstLineIn}in`
  } as React.CSSProperties;
  const firstHeader = hfFor(meta, 'header', 0);
  const insertFootnote = () => {
    const pos = editor.state.selection.to;
    editor.chain().focus().setTextSelection(pos).insertFootnote('').run();
    (editor.storage as any).footnote.onEdit?.(pos, '');
  };

  return (
    <div className={`doc-editor ${focusMode ? 'focus-mode' : ''}`}>
      <Toolbar
        editor={editor}
        zoom={zoom}
        setZoom={setZoom}
        onLink={setLink}
        onImage={insertImage}
        paper={paper}
        setPaper={setPaper}
        onSave={save}
        onExportPdf={exportPdf}
        onExportHtml={exportHtml}
        onExportText={exportText}
        onPrint={print}
        onFind={() => setFindOpen('find')}
        onPageSetup={() => setDialog('page')}
        onHeaderFooter={() => setDialog('hf')}
        onFootnote={insertFootnote}
        onCite={() => (setCiteTarget(null), setDialog('cite'))}
        onBibliography={() => {
          editor.chain().focus().insertBibliography().run();
          setTimeout(() => refreshCitations(editor, metaRef.current), 0);
        }}
        onToc={() => editor.chain().focus().insertToc().run()}
        onFocusMode={() => {
          setFocusMode(true);
          document.documentElement.requestFullscreen?.().catch(() => {});
          toast('Focus mode. Press Esc to exit.');
        }}
      />
      {dialog === 'page' && <PageSetupDialog meta={meta} onClose={() => setDialog(null)} onApply={updateMeta} />}
      {dialog === 'hf' && <HeaderFooterDialog meta={meta} author={userName} onClose={() => setDialog(null)} onApply={updateMeta} />}
      {dialog === 'cite' && (
        <CitationsDialog
          meta={meta}
          target={citeTarget}
          hasBibliography={(() => {
            let has = false;
            editor.state.doc.descendants((n) => {
              if (n.type.name === 'bibliography') has = true;
            });
            return has;
          })()}
          onMeta={updateMeta}
          onCite={(ids, page) => {
            if (citeTarget) {
              const node = editor.state.doc.nodeAt(citeTarget.pos);
              if (node?.type.name === 'citation') editor.view.dispatch(editor.state.tr.setNodeMarkup(citeTarget.pos, undefined, { ...node.attrs, ids, page }));
            } else editor.chain().focus().insertCitation(ids, page).run();
            setTimeout(() => refreshCitations(editor, metaRef.current), 0);
          }}
          onRemoveCite={() => citeTarget && editor.view.dispatch(editor.state.tr.delete(citeTarget.pos, citeTarget.pos + 1))}
          onBibliography={() => {
            editor.chain().focus('end').setPageBreak().insertBibliography().run();
            setTimeout(() => refreshCitations(editor, metaRef.current), 0);
          }}
          onClose={() => (setDialog(null), setCiteTarget(null), editor.commands.focus())}
        />
      )}
      <ContextBar editor={editor} />
      {findOpen && <FindBar editor={editor} mode={findOpen} onClose={() => (setFindOpen(false), editor.commands.setSearch(''), editor.commands.focus())} />}
      <div
        className="doc-scroll"
        onMouseDown={(e) => {
          // Clicking the grey margin focuses the end of the document, like a word processor.
          if (e.target === e.currentTarget) {
            e.preventDefault();
            editor.commands.focus('end');
          }
        }}
        onDrop={(e) => {
          if (Array.from(e.dataTransfer.files).some((f) => f.type.startsWith('image/'))) e.stopPropagation();
        }}
      >
        <div className={`doc-page paper-${paper} ${meta.pageless ? 'pageless' : 'paged'}`} style={pageVars} onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), editor.commands.focus('end'))}>
          {!meta.pageless && (
            <div
              className="pg-hf pg-header first"
              style={{ top: box.hd, left: box.ml, right: box.mr }}
              onMouseDown={(e) => (e.preventDefault(), setDialog('hf'))}
              dangerouslySetInnerHTML={{ __html: hfHtml(firstHeader, meta.pageNumberStart || 1, pages + (meta.pageNumberStart || 1) - 1, { meta, title: baseName(tab.name), author: userName }) || '<span class="hf-empty">Header</span>' }}
            />
          )}
          <EditorContent editor={editor} />
        </div>
      </div>
      <div className="statusbar">
        {!meta.pageless && (
          <span>
            {pages} page{pages === 1 ? '' : 's'}
          </span>
        )}
        <button
          className="sb-btn"
          title={meta.wordGoal ? 'Change word goal' : 'Set a word goal'}
          onClick={async () => {
            const v = await prompt('Word goal', 'How many words are you aiming for? Leave empty for none.', meta.wordGoal ? String(meta.wordGoal) : '', 'e.g. 1500');
            if (v === null) return;
            const n = parseInt(v.replace(/[^\d]/g, ''), 10);
            updateMeta({ ...metaRef.current, wordGoal: n > 0 ? n : null });
          }}
        >
          {selWords ? `${selWords.toLocaleString()} of ` : ''}
          {counts.words.toLocaleString()}
          {meta.wordGoal ? ` / ${meta.wordGoal.toLocaleString()}` : ''} word{counts.words === 1 && !meta.wordGoal ? '' : 's'}
          {meta.wordGoal ? (
            <span className="goal-bar">
              <span style={{ width: `${Math.min(100, (100 * counts.words) / meta.wordGoal)}%`, background: counts.words >= meta.wordGoal ? 'var(--success)' : undefined }} />
            </span>
          ) : (
            <Target size={12} style={{ marginLeft: 4, opacity: 0.6 }} />
          )}
        </button>
        <span>{counts.chars.toLocaleString()} characters</span>
        <span className="grow" />
        {showHints && (
          <span>
            <span className="kbd-chip">Enter</span> new paragraph · <span className="kbd-chip">Shift+Enter</span> line break · <span className="kbd-chip">Ctrl+Enter</span> page break
          </span>
        )}
        <span className="zoom-ctl">
          <button className="icon-btn sm" title="Zoom out (Ctrl+-)" onClick={() => setZoom(clamp(Math.round((zoom - 0.1) * 10) / 10, 0.5, 2.5))}>
            <Minus size={14} />
          </button>
          <button className="zoom-pct" title="Reset zoom (Ctrl+0)" onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button className="icon-btn sm" title="Zoom in (Ctrl++)" onClick={() => setZoom(clamp(Math.round((zoom + 0.1) * 10) / 10, 0.5, 2.5))}>
            <Plus size={14} />
          </button>
        </span>
      </div>
    </div>
  );
}

// ---------- Toolbar ----------
function Toolbar(p: {
  editor: Editor;
  zoom: number;
  setZoom(z: number): void;
  onLink(): void;
  onImage(): void;
  paper: 'dark' | 'light';
  setPaper(p: 'dark' | 'light'): void;
  onSave(saveAs: boolean): void;
  onExportPdf(): void;
  onExportHtml(): void;
  onExportText(): void;
  onPrint(): void;
  onFind(): void;
  onPageSetup(): void;
  onHeaderFooter(): void;
  onFootnote(): void;
  onCite(): void;
  onBibliography(): void;
  onToc(): void;
  onFocusMode(): void;
}) {
  const { editor } = p;
  const chain = () => editor.chain().focus();
  const block = editor.isActive('heading', { level: 1 })
    ? 'h1'
    : editor.isActive('heading', { level: 2 })
      ? 'h2'
      : editor.isActive('heading', { level: 3 })
        ? 'h3'
        : editor.isActive('heading', { level: 4 })
          ? 'h4'
          : editor.isActive('blockquote')
            ? 'quote'
            : editor.isActive('codeBlock')
              ? 'code'
              : 'p';
  const ts = editor.getAttributes('textStyle');
  const font = (ts.fontFamily || '').split(',')[0].replace(/["']/g, '') || editor.storage.pagination?.input?.()?.meta?.defaults?.font || 'Arial';
  const size = ts.fontSize ? parseFloat(ts.fontSize) : block === 'p' ? editor.storage.pagination?.input?.()?.meta?.defaults?.sizePt || 11 : BLOCK_SIZE[block] || 11;
  const align = (['center', 'right', 'justify'] as const).find((a) => editor.isActive({ textAlign: a })) || 'left';
  const AlignIcon = align === 'center' ? AlignCenter : align === 'right' ? AlignRight : align === 'justify' ? AlignJustify : AlignLeft;

  const setBlock = (v: string) => {
    const c = chain();
    if (v === 'p') c.setParagraph();
    else if (v === 'quote') c.setParagraph().toggleBlockquote();
    else if (v === 'code') c.toggleCodeBlock();
    else c.setHeading({ level: Number(v[1]) as 1 | 2 | 3 | 4 });
    c.run();
  };
  const setSize = (n: number) => chain().setFontSize(`${clamp(n, 1, 400)}pt`).run();
  const B = (props: { on?: boolean; title: string; onClick(): void; children: React.ReactNode; disabled?: boolean }) => (
    <button className={`icon-btn ${props.on ? 'active' : ''}`} title={props.title} onMouseDown={(e) => e.preventDefault()} onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  );

  return (
    <div className="toolbar">
      <B title="Undo (Ctrl+Z)" onClick={() => chain().undo().run()} disabled={!editor.can().undo()}>
        <Undo2 size={18} />
      </B>
      <B title="Redo (Ctrl+Y)" onClick={() => chain().redo().run()} disabled={!editor.can().redo()}>
        <Redo2 size={18} />
      </B>
      <div className="tb-sep" />
      <select className="select" style={{ width: 120 }} value={block} onChange={(e) => setBlock(e.target.value)} title="Text style">
        <option value="p">Normal text</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
        <option value="h4">Heading 4</option>
        <option value="quote">Quote</option>
        <option value="code">Code</option>
      </select>
      <div className="tb-sep" />
      <select className="select" style={{ width: 118, fontFamily: font }} value={FONTS.includes(font) ? font : '__other'} onChange={(e) => chain().setFontFamily(e.target.value).run()} title="Font">
        {!FONTS.includes(font) && <option value="__other">{font}</option>}
        {FONTS.map((f) => (
          <option key={f} value={f} style={{ fontFamily: f }}>
            {f}
          </option>
        ))}
      </select>
      <div className="tb-sep" />
      <div className="size-ctl">
        <button className="icon-btn sm" title="Decrease size" onMouseDown={(e) => e.preventDefault()} onClick={() => setSize([...SIZES].reverse().find((s) => s < size) ?? size - 1)}>
          <Minus size={14} />
        </button>
        <MenuButton
          button={() => (
            <button className="size-val" title="Font size">
              {Math.round(size * 10) / 10}
            </button>
          )}
        >
          {(close) => (
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              {SIZES.map((s) => (
                <button key={s} className="menu-item" onClick={() => (setSize(s), close())}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </MenuButton>
        <button className="icon-btn sm" title="Increase size" onMouseDown={(e) => e.preventDefault()} onClick={() => setSize(SIZES.find((s) => s > size) ?? size + 1)}>
          <Plus size={14} />
        </button>
      </div>
      <div className="tb-sep" />
      <B on={editor.isActive('bold')} title="Bold (Ctrl+B)" onClick={() => chain().toggleBold().run()}>
        <Bold size={18} />
      </B>
      <B on={editor.isActive('italic')} title="Italic (Ctrl+I)" onClick={() => chain().toggleItalic().run()}>
        <Italic size={18} />
      </B>
      <B on={editor.isActive('underline')} title="Underline (Ctrl+U)" onClick={() => chain().toggleUnderline().run()}>
        <UIcon size={18} />
      </B>
      <ColorPicker title="Text color" icon={<Baseline size={18} />} value={ts.color || null} allowNone noneLabel="Automatic" onChange={(c) => (c ? chain().setColor(c).run() : chain().unsetColor().run())} />
      <ColorPicker
        title="Highlight color"
        icon={<Highlighter size={18} />}
        value={editor.getAttributes('highlight').color || null}
        allowNone
        onChange={(c) => (c ? chain().setHighlight({ color: c }).run() : chain().unsetHighlight().run())}
      />
      <div className="tb-sep" />
      <B on={editor.isActive('link')} title="Link (Ctrl+K)" onClick={p.onLink}>
        <Link2 size={18} />
      </B>
      <B title="Insert image" onClick={p.onImage}>
        <ImagePlus size={18} />
      </B>
      <MenuButton title="Insert table" button={(open) => <button className={`icon-btn ${open ? 'active' : ''}`}><Table2 size={18} /></button>}>
        {(close) => <TableGrid onPick={(r, c) => (chain().insertTable({ rows: r, cols: c, withHeaderRow: true }).run(), close())} />}
      </MenuButton>
      <div className="tb-sep" />
      <MenuButton title="Align" button={(open) => <button className={`icon-btn ${open ? 'active' : ''}`}><AlignIcon size={18} /></button>}>
        {(close) => (
          <div style={{ display: 'flex', gap: 2 }}>
            {(
              [
                ['left', AlignLeft, 'Left (Ctrl+Shift+L)'],
                ['center', AlignCenter, 'Center (Ctrl+Shift+E)'],
                ['right', AlignRight, 'Right (Ctrl+Shift+R)'],
                ['justify', AlignJustify, 'Justify (Ctrl+Shift+J)']
              ] as const
            ).map(([a, Icon, t]) => (
              <button key={a} className={`icon-btn ${align === a ? 'active' : ''}`} title={t} onClick={() => (chain().setTextAlign(a).run(), close())}>
                <Icon size={18} />
              </button>
            ))}
          </div>
        )}
      </MenuButton>
      <MenuButton title="Line & paragraph spacing" button={(open) => <button className={`icon-btn ${open ? 'active' : ''}`}><WrapText size={18} /></button>}>
        {(close) => {
          const cur = editor.getAttributes('paragraph').lineHeight || editor.getAttributes('heading').lineHeight || null;
          const ti = editor.getAttributes('paragraph').textIndent;
          return (
            <>
              <div className="menu-title">Line spacing</div>
              {[
                [null, 'Document default'],
                ['1', 'Single'],
                ['1.15', '1.15'],
                ['1.5', '1.5'],
                ['2', 'Double']
              ].map(([v, label]) => (
                <button key={label} className="menu-item" onClick={() => (chain().setLineHeight(v).run(), close())}>
                  <span style={{ width: 14 }}>{String(cur ?? null) === String(v) ? '✓' : ''}</span> {label}
                </button>
              ))}
              <div className="menu-sep" />
              <div className="menu-title">Indent</div>
              {(
                [
                  [null, 'Document default'],
                  [0, 'None'],
                  [0.5, 'First line 0.5"'],
                  [-0.5, 'Hanging 0.5" (works cited)']
                ] as const
              ).map(([v, label]) => (
                <button key={label} className="menu-item" onClick={() => (chain().setTextIndent(v).run(), close())}>
                  <span style={{ width: 14 }}>{(ti ?? null) === v ? '✓' : ''}</span> {label}
                </button>
              ))}
            </>
          );
        }}
      </MenuButton>
      <B on={editor.isActive('taskList')} title="Checklist" onClick={() => chain().toggleTaskList().run()}>
        <ListChecks size={18} />
      </B>
      <B on={editor.isActive('bulletList')} title="Bulleted list (Ctrl+Shift+8)" onClick={() => chain().toggleBulletList().run()}>
        <List size={18} />
      </B>
      <B on={editor.isActive('orderedList')} title="Numbered list (Ctrl+Shift+7)" onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered size={18} />
      </B>
      <B
        title="Decrease indent (Shift+Tab)"
        onClick={() => (editor.isActive('listItem') ? chain().liftListItem('listItem').run() : editor.isActive('taskItem') ? chain().liftListItem('taskItem').run() : chain().outdent().run())}
      >
        <IndentDecrease size={18} />
      </B>
      <B
        title="Increase indent (Tab)"
        onClick={() => (editor.isActive('listItem') ? chain().sinkListItem('listItem').run() : editor.isActive('taskItem') ? chain().sinkListItem('taskItem').run() : chain().indent().run())}
      >
        <IndentIncrease size={18} />
      </B>
      <B title="Clear formatting (Ctrl+\)" onClick={() => chain().unsetAllMarks().setParagraph().setLineHeight(null).run()}>
        <RemoveFormatting size={18} />
      </B>
      <MenuButton title="More formatting" button={(open) => <button className={`icon-btn ${open ? 'active' : ''}`}><Heading size={18} /></button>}>
        {(close) => (
          <>
            <button className="menu-item" onClick={() => (chain().toggleStrike().run(), close())}>
              <Strikethrough size={16} /> Strikethrough <span className="kbd">Ctrl+Shift+X</span>
            </button>
            <button className="menu-item" onClick={() => (chain().toggleSuperscript().run(), close())}>
              <SupIcon size={16} /> Superscript <span className="kbd">Ctrl+.</span>
            </button>
            <button className="menu-item" onClick={() => (chain().toggleSubscript().run(), close())}>
              <SubIcon size={16} /> Subscript <span className="kbd">Ctrl+,</span>
            </button>
            <button className="menu-item" onClick={() => (chain().toggleCode().run(), close())}>
              <Code2 size={16} /> Inline code <span className="kbd">Ctrl+E</span>
            </button>
            <button className="menu-item" onClick={() => (chain().toggleBlockquote().run(), close())}>
              <Quote size={16} /> Quote
            </button>
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => (chain().setHorizontalRule().run(), close())}>
              <Minus size={16} /> Horizontal line
            </button>
            <button className="menu-item" onClick={() => (chain().setPageBreak().run(), close())}>
              <SeparatorHorizontal size={16} /> Page break <span className="kbd">Ctrl+Enter</span>
            </button>
          </>
        )}
      </MenuButton>

      <MenuButton title="Insert" button={(open) => <button className={`icon-btn ${open ? 'active' : ''}`}><PlusSquare size={18} /></button>}>
        {(close) => (
          <>
            <div className="menu-title">Insert</div>
            <button className="menu-item" onClick={() => (p.onCite(), close())}>
              <QuoteIcon size={16} /> Citation <span className="kbd">Ctrl+Alt+C</span>
            </button>
            <button className="menu-item" onClick={() => (p.onBibliography(), close())}>
              <BookOpen size={16} /> Works Cited / References
            </button>
            <button className="menu-item" onClick={() => (p.onToc(), close())}>
              <ListTree size={16} /> Table of contents
            </button>
            <button className="menu-item" onClick={() => (p.onFootnote(), close())}>
              <Asterisk size={16} /> Footnote <span className="kbd">Ctrl+Alt+F</span>
            </button>
            <button className="menu-item" onClick={() => (chain().setPageBreak().run(), close())}>
              <SeparatorHorizontal size={16} /> Page break <span className="kbd">Ctrl+Enter</span>
            </button>
            <button className="menu-item" onClick={() => (chain().setHorizontalRule().run(), close())}>
              <Minus size={16} /> Horizontal line
            </button>
            <button className="menu-item" onClick={() => (chain().insertContent(new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })).run(), close())}>
              <CalendarDays size={16} /> Today's date
            </button>
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => (p.onHeaderFooter(), close())}>
              <PanelTop size={16} /> Header, footer &amp; page numbers
            </button>
            <button className="menu-item" onClick={() => (p.onPageSetup(), close())}>
              <FileCog size={16} /> Page setup
            </button>
          </>
        )}
      </MenuButton>

      <div className="tb-spacer" />
      <B title="Page setup" onClick={p.onPageSetup}>
        <FileCog size={18} />
      </B>
      <B title="Focus mode" onClick={p.onFocusMode}>
        <Maximize2 size={18} />
      </B>
      <B title="Find and replace (Ctrl+F)" onClick={p.onFind}>
        <Search size={18} />
      </B>
      <B title={p.paper === 'dark' ? 'Light page' : 'Dark page'} onClick={() => p.setPaper(p.paper === 'dark' ? 'light' : 'dark')}>
        {p.paper === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </B>
      <div className="tb-sep" />
      <div className="tb-end">
      <AiButton />
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
            <button className="menu-item" onClick={() => (p.onExportPdf(), close())}>
              <FileDown size={16} /> Export as PDF…
            </button>
            <button className="menu-item" onClick={() => (p.onExportHtml(), close())}>
              <FileText size={16} /> Export as web page…
            </button>
            <button className="menu-item" onClick={() => (p.onExportText(), close())}>
              <FileText size={16} /> Export as plain text…
            </button>
            <div className="menu-sep" />
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

function TableGrid({ onPick }: { onPick(rows: number, cols: number): void }) {
  const [hover, setHover] = useState({ r: 0, c: 0 });
  return (
    <div style={{ padding: 6 }}>
      <div className="table-grid" onMouseLeave={() => setHover({ r: 0, c: 0 })}>
        {Array.from({ length: 8 * 10 }, (_, i) => {
          const r = Math.floor(i / 10) + 1,
            c = (i % 10) + 1;
          return <div key={i} className={`tg-cell ${r <= hover.r && c <= hover.c ? 'on' : ''}`} onMouseEnter={() => setHover({ r, c })} onClick={() => onPick(r, c)} />;
        })}
      </div>
      <div style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 12, marginTop: 6 }}>{hover.r ? `${hover.r} × ${hover.c}` : 'Insert table'}</div>
    </div>
  );
}

/** Extra controls that appear when the cursor is in a table or an image is selected. */
function ContextBar({ editor }: { editor: Editor }) {
  const chain = () => editor.chain().focus();
  const inTable = editor.isActive('table');
  const img = editor.isActive('image');
  if (!inTable && !img) return null;
  const btn = (title: string, icon: React.ReactNode, fn: () => void, danger = false) => (
    <button className="btn tonal sm" title={title} onMouseDown={(e) => e.preventDefault()} onClick={fn} style={danger ? { color: 'var(--danger)' } : undefined}>
      {icon}
      {title}
    </button>
  );
  if (img) {
    const a = editor.getAttributes('image');
    return (
      <div className="context-bar">
        <span className="tb-label">Image size</span>
        {['25%', '50%', '75%', '100%'].map((w) => (
          <button key={w} className={`btn sm ${a.width === w ? 'primary' : 'tonal'}`} onMouseDown={(e) => e.preventDefault()} onClick={() => chain().updateAttributes('image', { width: w }).run()}>
            {w}
          </button>
        ))}
        <div className="tb-sep" />
        {(['left', 'center', 'right'] as const).map((al) => {
          const Icon = al === 'left' ? AlignLeft : al === 'center' ? AlignCenter : AlignRight;
          return (
            <button key={al} className={`icon-btn sm ${(a.align || 'left') === al ? 'active' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => chain().updateAttributes('image', { align: al }).run()}>
              <Icon size={16} />
            </button>
          );
        })}
        <div className="tb-spacer" />
        {btn('Remove', <Trash2 size={14} />, () => chain().deleteSelection().run(), true)}
      </div>
    );
  }
  return (
    <div className="context-bar">
      <span className="tb-label">Table</span>
      {btn('Row above', <ArrowUpToLine size={14} />, () => chain().addRowBefore().run())}
      {btn('Row below', <ArrowDownToLine size={14} />, () => chain().addRowAfter().run())}
      {btn('Column left', <ArrowLeftToLine size={14} />, () => chain().addColumnBefore().run())}
      {btn('Column right', <ArrowRightToLine size={14} />, () => chain().addColumnAfter().run())}
      <div className="tb-sep" />
      {btn('Merge', <TableCellsMerge size={14} />, () => chain().mergeCells().run())}
      {btn('Split', <TableCellsSplit size={14} />, () => chain().splitCell().run())}
      {btn('Header row', <Rows3 size={14} />, () => chain().toggleHeaderRow().run())}
      <div className="tb-spacer" />
      {btn('Delete row', <Rows3 size={14} />, () => chain().deleteRow().run(), true)}
      {btn('Delete column', <Columns3 size={14} />, () => chain().deleteColumn().run(), true)}
      {btn('Delete table', <Trash2 size={14} />, () => chain().deleteTable().run(), true)}
    </div>
  );
}

function FindBar({ editor, mode, onClose }: { editor: Editor; mode: 'find' | 'replace'; onClose(): void }) {
  const [q, setQ] = useState('');
  const [rep, setRep] = useState('');
  const [cs, setCs] = useState(false);
  const [showRep, setShowRep] = useState(mode === 'replace');
  const inputRef = useRef<HTMLInputElement>(null);
  const st = searchKey.getState(editor.state);
  const total = st?.matches.length || 0;
  const idx = st?.index || 0;

  useEffect(() => {
    inputRef.current?.focus();
    const sel = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ');
    if (sel && sel.length < 80) setQ(sel);
  }, []);
  useEffect(() => setShowRep((s) => s || mode === 'replace'), [mode]);
  useEffect(() => {
    editor.commands.setSearch(q, cs);
  }, [q, cs]);

  const reveal = (i: number) => {
    const m = searchKey.getState(editor.state)?.matches[i];
    if (!m) return;
    editor.commands.setSearchIndex(i);
    editor.commands.setTextSelection(m);
    editor.commands.scrollIntoView();
    // Keep typing in the find box.
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  const step = (d: number) => total && reveal((idx + d + total) % total);
  const replaceOne = () => {
    const m = st?.matches[idx];
    if (!m) return;
    editor.chain().insertContentAt(m, rep).run();
    setTimeout(() => reveal(Math.min(idx, (searchKey.getState(editor.state)?.matches.length || 1) - 1)), 0);
  };
  const replaceAll = () => {
    const ms = [...(st?.matches || [])].reverse();
    if (!ms.length) return;
    let tr = editor.state.tr;
    for (const m of ms) tr = tr.insertText(rep, m.from, m.to);
    editor.view.dispatch(tr);
    toast(`Replaced ${ms.length} match${ms.length > 1 ? 'es' : ''}`, 'success');
  };

  return (
    <div className="find-bar">
      <div className="find-row">
        <Search size={16} color="var(--text-3)" />
        <input
          ref={inputRef}
          placeholder="Find"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
            if (e.key === 'Escape') onClose();
          }}
        />
        <span className="tb-label">{q ? (total ? `${idx + 1} of ${total}` : 'No results') : ''}</span>
        <button className={`icon-btn sm ${cs ? 'active' : ''}`} title="Match case" onClick={() => setCs((c) => !c)} style={{ fontSize: 12, fontWeight: 600 }}>
          Aa
        </button>
        <button className="icon-btn sm" onClick={() => step(-1)} disabled={!total}>
          <ChevronUp size={16} />
        </button>
        <button className="icon-btn sm" onClick={() => step(1)} disabled={!total}>
          <ChevronDown size={16} />
        </button>
        <button className={`icon-btn sm ${showRep ? 'active' : ''}`} title="Replace (Ctrl+H)" onClick={() => setShowRep((s) => !s)}>
          <span style={{ fontSize: 11, fontWeight: 600 }}>A→B</span>
        </button>
        <button className="icon-btn sm" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {showRep && (
        <div className="find-row">
          <span style={{ width: 16 }} />
          <input placeholder="Replace with" value={rep} onChange={(e) => setRep(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && replaceOne()} />
          <button className="btn sm tonal" onClick={replaceOne} disabled={!total}>
            Replace
          </button>
          <button className="btn sm tonal" onClick={replaceAll} disabled={!total}>
            Replace all
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Standalone HTML used for print, PDF export and .html saving (always light paper).
 * For print and PDF the document is cut into the same pages as on screen, each with its header,
 * footnotes and footer, so the output matches what you see.
 */
function printableHtml(editor: Editor, title: string, forPrint: boolean, meta: DocMeta): string {
  const b = pageBox(meta);
  const D = meta.defaults;
  const name = baseName(title);
  const serializer = DOMSerializer.fromSchema(editor.schema);
  const nodeHtml = (i: number) => {
    const wrap = document.createElement('div');
    wrap.appendChild(serializer.serializeNode(editor.state.doc.child(i)));
    return wrap.innerHTML;
  };
  const esc = (s: string) => escapeHtml(s);
  const notesBlock = (notes: { n: number; text: string }[]) =>
    notes.length ? `<div class="notes"><div class="notes-rule"></div>${notes.map((n) => `<div class="note"><sup>${n.n}</sup> ${esc(n.text)}</div>`).join('')}</div>` : '';
  const paged = forPrint && !meta.pageless;
  let body = '';
  if (paged) {
    const groups = pageGroups(editor.state);
    const start = meta.pageNumberStart || 1;
    const total = groups.length + start - 1;
    const input = { meta, title: name, author: setting<string>('user.name') };
    body = groups
      .map((g, i) => {
        const head = hfHtml(hfFor(meta, 'header', i), i + start, total, input);
        const foot = hfHtml(hfFor(meta, 'footer', i), i + start, total, input);
        return `<section class="page">${head ? `<div class="hf head">${head}</div>` : ''}<div class="content">${g.nodes.map(nodeHtml).join('')}</div>${notesBlock(g.notes)}${foot ? `<div class="hf foot">${foot}</div>` : ''}</section>`;
      })
      .join('');
  } else {
    const notes = footnotesOf(editor.state.doc).map(({ n, text }) => ({ n, text }));
    body = `<div class="content">${editor.getHTML()}</div>${notes.length ? `<h3>Notes</h3>${notesBlock(notes)}` : ''}`;
  }
  const embedded = btoa(unescape(encodeURIComponent(JSON.stringify(meta))));
  const pageW = (meta.page.landscape ? meta.page.height : meta.page.width).toFixed(3);
  const pageH = (meta.page.landscape ? meta.page.width : meta.page.height).toFixed(3);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(name)}</title>
${forPrint ? '' : `<meta name="slate-doc" content="${embedded}">`}
<style>
${paged ? `@page { size: ${pageW}in ${pageH}in; margin: 0; }` : forPrint ? `@page { size: ${pageW}in ${pageH}in; margin: ${meta.page.margins.top}in ${meta.page.margins.right}in ${meta.page.margins.bottom}in ${meta.page.margins.left}in; }` : ''}
:root { --doc-font: '${D.font}', Arial, sans-serif; --doc-size: ${D.sizePt}pt; --doc-lh: ${cssLineHeight(D.lineHeight)}; --doc-after: ${D.spaceAfterPt}pt; --doc-first: ${D.firstLineIn}in; }
html, body { margin: 0; padding: 0; background: #fff; }
body { font-family: var(--doc-font); font-size: var(--doc-size); line-height: var(--doc-lh); color: #202124; counter-reset: fn; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
${paged ? '' : forPrint ? '' : 'body { max-width: 6.5in; margin: 1in auto; padding: 0 24px; }'}
.page { position: relative; width: ${b.w}px; height: ${b.h}px; padding: ${b.mt}px ${b.mr}px ${b.mb}px ${b.ml}px; box-sizing: border-box; overflow: hidden; break-after: page; page-break-after: always; }
.page:last-child { break-after: auto; page-break-after: auto; }
.hf { position: absolute; left: ${b.ml}px; right: ${b.mr}px; display: grid; grid-template-columns: 1fr auto 1fr; font-size: var(--doc-size); white-space: pre; }
.hf.head { top: ${b.hd}px; }
.hf.foot { bottom: ${b.fd}px; }
.hf .hf-c { text-align: center; } .hf .hf-r { text-align: right; }
.notes { position: absolute; left: ${b.ml}px; right: ${b.mr}px; bottom: ${b.mb}px; font-size: 10pt; line-height: 1.25; }
.notes-rule { width: 2in; border-top: 1px solid #5f6368; margin: 0 0 4px; }
.note sup { font-size: 0.75em; }
.fn-ref { font-size: 0.75em; line-height: 0; }
.fn-ref::after { counter-increment: fn; content: counter(fn); }
p { margin: 0 0 var(--doc-after); min-height: 1em; line-height: calc(var(--lh, ${D.lineHeight}) * 1.15); }
.content > p { text-indent: var(--doc-first); }
h1, h2, h3, h4 { line-height: calc(var(--lh, 1.08) * 1.15); text-indent: 0; }
h1 { font-size: 20pt; font-weight: 400; margin: 18pt 0 6pt; }
h2 { font-size: 16pt; font-weight: 400; margin: 16pt 0 6pt; }
h3 { font-size: 14pt; font-weight: 400; color: #434343; margin: 14pt 0 4pt; }
h4 { font-size: 12pt; font-weight: 700; color: #434343; margin: 12pt 0 4pt; }
.content > :first-child { margin-top: 0; }
ul, ol { margin: 0 0 var(--doc-after); padding-left: 24pt; }
li > p { margin: 0 0 2pt; text-indent: 0; }
ul[data-type="taskList"] { list-style: none; padding-left: 4pt; }
ul[data-type="taskList"] li { display: flex; gap: 6pt; }
ul[data-type="taskList"] li > label { flex: 0 0 auto; }
blockquote { border-left: 3px solid #dadce0; margin: 0 0 6pt; padding-left: 12pt; color: #5f6368; }
pre { background: #f1f3f4; padding: 8pt 10pt; border-radius: 4pt; font-family: Consolas, 'Courier New', monospace; font-size: 10pt; white-space: pre-wrap; }
code { font-family: Consolas, 'Courier New', monospace; background: #f1f3f4; padding: 0 2pt; border-radius: 2pt; }
table { border-collapse: collapse; width: 100%; margin: 0 0 8pt; }
td, th { border: 1px solid #c4c7c5; padding: 4pt 6pt; vertical-align: top; }
th { background: #f1f3f4; font-weight: 600; text-align: left; }
td p, th p { margin: 0; text-indent: 0; }
img { max-width: 100%; height: auto; display: block; }
img[data-align="center"] { margin-left: auto; margin-right: auto; }
img[data-align="right"] { margin-left: auto; }
hr { border: none; border-top: 1px solid #c4c7c5; margin: 10pt 0; }
a { color: #1155cc; }
.page-break { ${paged ? 'display: none;' : 'break-after: page; page-break-after: always; height: 0;'} }
.bibliography, .toc { text-indent: 0; }
.bib-title { text-align: center; margin: 0; ${meta.citationStyle === 'apa' ? 'font-weight: 700;' : ''} }
.bib-entry { padding-left: 0.5in; text-indent: -0.5in; margin: 0; overflow-wrap: anywhere; }
.bib-empty, .toc-empty { display: none; }
.toc-title { font-weight: 700; margin: 0 0 6pt; }
.toc-entry { display: flex; align-items: baseline; gap: 4px; margin: 0 0 2pt; }
.toc-dots { flex: 1; border-bottom: 1px dotted #5f6368; transform: translateY(-3px); }
mark { color: inherit; }
</style></head><body>${body}</body></html>`;
}

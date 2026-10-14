import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles,
  X,
  Pin,
  PinOff,
  Settings2,
  Lightbulb,
  ListCollapse,
  Wand2,
  Send,
  Square,
  Copy,
  RotateCcw,
  Replace,
  CornerDownLeft,
  Plus,
  Search,
  Check,
  GraduationCap,
  Layers,
  ListChecks,
  ScrollText,
  Globe
} from 'lucide-react';
import { wikiQuery, wikiChars } from '../../lib/ai';
import { FlashcardsView, QuizView } from './Study';
import { MenuButton } from '../Popover';
import { openSettings, useSettings } from '../../lib/settings';
import type { AiHooks } from '../../store';
import { useAi, setAiOpen, AiMessage } from './aiStore';
import { useTabs, editorRegistry, toast, prompt as askText } from '../../store';
import { api } from '../../lib/api';
import { DEPTHS, Depth } from '../../lib/ai';
import { runExplain, runSummarize, runAsk, runSuggest, runFlashcards, runQuiz, Difficulty, TaskContext, TaskCallbacks, wordCount, markdownToHtml, markdownToPlain, Suggestion } from '../../lib/ai';
import { uid } from '../../lib/util';
import { ModelSetup } from './ModelSetup';
import '../../styles/ai.css';

let cancelFlag = { cancelled: false };

export type EditMode = 'suggest' | 'track' | 'direct';
const EDIT_MODES: { id: EditMode; label: string; help: string }[] = [
  { id: 'suggest', label: 'Suggest', help: 'AI edits wait in this sidebar until you click Apply or Replace.' },
  { id: 'track', label: 'Ask first', help: 'AI edits go into the document as suggestions from "Slate AI" that you accept or reject (documents only; elsewhere this works like Suggest).' },
  { id: 'direct', label: 'Edit directly', help: 'AI edits change the text right away. Ctrl+Z undoes them.' }
];
/** Asking to change highlighted text ("make this formal", "fix the grammar"…) rather than asking about it. */
const EDIT_REQUEST = /^\s*(please\s+)?(make|rewrite|re-write|rephrase|reword|turn|convert|fix|correct|shorten|lengthen|expand|simplify|translate|change|improve|edit|proofread|paraphrase|polish|tighten|condense|clean up|format|capitali[sz]e|put)\b/i;

/** Wrap the editor's edit hooks so they follow the chosen edit mode. */
function withMode(h: AiHooks | undefined, mode: EditMode): AiHooks | undefined {
  if (!h || mode !== 'track' || !h.track) return h;
  const t = h.track.bind(h);
  return {
    ...h,
    noun: h.noun,
    insertLabel: h.insertLabel,
    getDocument: () => h.getDocument(),
    ...(h.replaceSelection ? { replaceSelection: (s: string) => t(() => h.replaceSelection!(s)) } : {}),
    ...(h.insertText ? { insertText: (s: string) => t(() => h.insertText!(s)) } : {}),
    ...(h.replaceQuote ? { replaceQuote: (q: string, r: string) => t(() => h.replaceQuote!(q, r)) } : {})
  };
}

export function AiSidebar() {
  const ai = useAi();
  const activeId = useTabs((s) => s.activeId);
  const tab = useTabs((s) => s.tabs.find((t) => t.id === s.activeId));
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rawHooks = editorRegistry.get(activeId)?.ai;
  const editMode = useSettings((s) => (s.values['ai.editMode'] as EditMode) || 'suggest');
  // "Ask first" only exists where the editor can track changes; elsewhere it behaves like Suggest.
  const effMode: EditMode = editMode === 'track' && !rawHooks?.track ? 'suggest' : editMode;
  const hooks = withMode(rawHooks, effMode);
  const canEdit = !!(rawHooks?.replaceQuote || rawHooks?.replaceSelection);
  const depth = useSettings((s) => (s.values['ai.depth'] as Depth) || 'standard');
  const instructions = useSettings((s) => String(s.values['ai.instructions'] || ''));
  const [showInstr, setShowInstr] = useState(false);
  const wikiOn = useSettings((s) => !!s.values['ai.wikipedia']);

  // Load model state when first opened.
  useEffect(() => {
    if (!ai.open) return;
    api.ai.state().then((state) => ai.set({ state }));
    const off = api.ai.onDownload((m) => {
      const st = useAi.getState().state;
      if (st) useAi.getState().set({ state: { ...st, models: st.models.map((x) => (x.tier === m.tier ? m : x)) } });
    });
    return off;
  }, [ai.open]);

  // Context text: pinned, the live selection for this tab, or the whole document.
  const selection = ai.pinned ? ai.pinnedText : ai.selections[activeId] || null;
  const scope: 'selection' | 'document' = !selection ? 'document' : ai.scope;
  const docName = tab?.name || 'this file';
  const noun = hooks?.noun || 'document';

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [ai.messages.length, ai.messages[ai.messages.length - 1]?.text, status]);

  const settings = ai.state?.settings;
  const model = ai.state?.models.find((m) => m.tier === settings?.tier);
  const ready = !!model?.installed;

  const getContext = async (): Promise<TaskContext | null> => {
    if (!hooks) {
      toast('Open a document to use the AI sidebar.');
      return null;
    }
    let text = '';
    if (scope === 'selection' && selection) text = selection;
    else text = (await hooks.getDocument()).full;
    if (!text.trim()) {
      toast(`There's no text in this ${noun} yet.`);
      return null;
    }
    return {
      text,
      scopeLabel: scope === 'selection' && selection ? 'the selected text' : `the whole ${noun}`,
      docName,
      noun,
      contextSize: settings?.contextSize || 8192,
      maxTokens: settings?.maxTokens || 1024
    };
  };

  const push = (m: AiMessage) => useAi.getState().set({ messages: [...useAi.getState().messages, m] });
  const patch = (id: string, p: Partial<AiMessage>) => useAi.getState().set({ messages: useAi.getState().messages.map((m) => (m.id === id ? { ...m, ...p } : m)) });

  /** Shared runner: adds the user + assistant bubbles, streams, handles errors and stop. */
  const run = async (label: string, userText: string, task: (ctx: TaskContext, cb: TaskCallbacks) => Promise<any>, kind: AiMessage['kind'] = 'text', opts: { autoReplace?: boolean; wiki?: boolean } = {}) => {
    if (ai.busy) return;
    if (!ready) {
      toast('Download an AI model first (it only takes a minute).');
      return;
    }
    const ctx = await getContext();
    if (!ctx) return;
    const ctxLabel = scope === 'selection' && selection ? `${wordCount(selection)} selected words` : `Whole ${noun}`;
    push({ id: uid(), role: 'user', text: userText, context: ctxLabel });
    const aid = uid();
    const retry = () => run(label, userText, task, kind, opts);
    push({ id: aid, role: 'assistant', text: '', kind, streaming: true, retry });
    cancelFlag = { cancelled: false };
    const flag = cancelFlag;
    useAi.getState().set({ busy: aid });
    setStatus(kind === 'text' ? '' : 'Starting…');
    try {
      // "Check Wikipedia": look the topic up first so the local model can use current facts.
      if (opts.wiki && useSettings.getState().values['ai.wikipedia']) {
        setStatus('Checking Wikipedia…');
        try {
          const q = await wikiQuery(scope === 'selection' && selection ? selection : ctx.text.slice(0, 1500), label === 'ask' ? userText : null, () => flag.cancelled);
          const refs = await api.wikiLookup(q, {
            lang: String(useSettings.getState().values['ai.wikiLang'] || 'en'),
            max: Number(useSettings.getState().values['ai.wikiArticles']) || 1,
            chars: wikiChars(depth, ctx.contextSize)
          });
          ctx.refs = refs;
          patch(aid, refs.length ? { wiki: refs.map((r) => ({ title: r.title, url: r.url, edited: r.edited })) } : { wikiNote: `No Wikipedia article found for “${q}”. Answered from the AI’s own knowledge.` });
        } catch (err: any) {
          if (err?.message === 'CANCELLED') throw err;
          patch(aid, { wikiNote: "Couldn't reach Wikipedia (offline?). Answered from the AI’s own knowledge." });
        }
        setStatus('');
      }
      const result = await task(ctx, {
        onToken: (full) => patch(aid, { text: full }),
        onStatus: (s) => setStatus(s),
        onRequest: (id) => patch(aid, { requestId: id }),
        cancelled: () => flag.cancelled
      });
      if (kind === 'flashcards' || kind === 'quiz') {
        if (result.length) patch(aid, { data: result, streaming: false, text: '' });
        else patch(aid, { kind: 'text', streaming: false, error: true, text: `I couldn't make ${kind === 'quiz' ? 'a quiz' : 'flashcards'} from this. Try a longer passage, or Try again.` });
      } else if (kind === 'suggestions') {
        if (!result.length) patch(aid, { kind: 'text', streaming: false, text: 'This reads well already. I have no specific edits to suggest.' });
        else if (effMode !== 'suggest' && hooks?.replaceQuote && !flag.cancelled) {
          // Ask first / Edit directly: put the edits into the document straight away.
          const applied: number[] = [];
          (result as Suggestion[]).forEach((s, i) => hooks.replaceQuote!(s.quote, s.suggestion) && applied.push(i));
          patch(aid, { data: result, streaming: false, text: '', applied, appliedHow: effMode as 'direct' | 'track' });
          if (applied.length)
            toast(
              effMode === 'track'
                ? `Added ${applied.length} suggested edit${applied.length > 1 ? 's' : ''} to the document. Accept or reject them there.`
                : `Made ${applied.length} edit${applied.length > 1 ? 's' : ''}. Ctrl+Z undoes them.`,
              'success'
            );
        } else patch(aid, { data: result, streaming: false, text: '' });
      } else {
        let replaced: AiMessage['replaced'];
        if (opts.autoReplace && effMode !== 'suggest' && hooks?.replaceSelection && !flag.cancelled && result.text.trim()) {
          if (hooks.replaceSelection(markdownToPlain(result.text))) replaced = effMode as 'direct' | 'track';
        }
        patch(aid, { streaming: false, text: result.text, speed: result.tokensPerSecond, replaced });
      }
    } catch (err: any) {
      if (err?.message === 'CANCELLED' || flag.cancelled) patch(aid, { streaming: false, text: (useAi.getState().messages.find((m) => m.id === aid)?.text || '') + '\n\n_Stopped._' });
      else if (err?.message?.includes('NO_MODEL')) patch(aid, { streaming: false, error: true, text: 'The selected model is not downloaded yet. Open AI settings to download it.' });
      else patch(aid, { streaming: false, error: true, text: err?.message || String(err) });
    } finally {
      setStatus('');
      useAi.getState().set({ busy: null });
    }
  };

  const stop = () => {
    cancelFlag.cancelled = true;
    const m = useAi.getState().messages.find((x) => x.id === useAi.getState().busy);
    if (m?.requestId) api.ai.stop(m.requestId);
  };

  const explain = () => run('explain', 'Explain this', runExplain, 'text', { wiki: true });
  const summarize = () => run('summarize', 'Summarize this', runSummarize);
  const suggest = () => run('suggest', 'Suggest edits', runSuggest, 'suggestions');
  const studyCount = (k: string, d: number) => Math.max(1, Math.min(30, Number(useSettings.getState().values[k]) || d));
  const studyLevel = () => ((useSettings.getState().values['ai.studyDifficulty'] as Difficulty) || 'medium');
  const flashcards = () => {
    const n = studyCount('ai.flashcardCount', 10);
    run('flashcards', `Make ${n} flashcards`, (ctx, cb) => runFlashcards(ctx, cb, n, studyLevel()), 'flashcards');
  };
  const quiz = () => {
    const n = studyCount('ai.quizCount', 5);
    run('quiz', `Quiz me (${n} questions)`, (ctx, cb) => runQuiz(ctx, cb, n, studyLevel()), 'quiz');
  };
  const send = () => {
    const q = input.trim();
    if (!q) return;
    setInput('');
    const history = useAi
      .getState()
      .messages.filter((m) => !m.error && !m.streaming && (m.kind || 'text') === 'text' && m.text)
      .slice(-6)
      .map((m) => ({ role: m.role, text: m.role === 'user' ? m.text : m.text.slice(0, 2000) }));
    // With a live highlight, "make this formal" etc. edits the text itself (unless edits are set to Suggest).
    const autoReplace = scope === 'selection' && !!selection && !ai.pinned && EDIT_REQUEST.test(q);
    run('ask', q, (ctx, cb) => runAsk(q, history, ctx, cb), 'text', { autoReplace, wiki: !autoReplace });
  };

  // Keyboard: Alt+1/2/3 quick actions, Ctrl+F searches the conversation when focus is in the sidebar.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ai.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && ['1', '2', '3'].includes(e.key)) {
        e.preventDefault();
        if (e.key === '1') explain();
        if (e.key === '2') summarize();
        if (e.key === '3') suggest();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && rootRef.current?.contains(document.activeElement)) {
        e.preventDefault();
        e.stopPropagation();
        setFindOpen(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const visible = useMemo(() => (find && findOpen ? ai.messages.filter((m) => (m.text + JSON.stringify(m.data || '')).toLowerCase().includes(find.toLowerCase())) : ai.messages), [ai.messages, find, findOpen]);

  return (
    <aside className={`ai-sidebar ${ai.open ? 'open' : ''}`} aria-hidden={!ai.open}>
      <div className="ai-inner" ref={rootRef}>
        <div className="ai-head">
          <div className="ai-title">
            <Sparkles size={17} />
            <span>AI</span>
            {model && <span className="ai-badge" title={`${model.model} · runs on this PC`}>{model.label} · local</span>}
          </div>
          <div style={{ display: 'flex' }}>
            {ai.messages.length > 0 && (
              <button className="icon-btn sm" title="Search conversation (Ctrl+F)" onClick={() => setFindOpen((o) => !o)}>
                <Search size={15} />
              </button>
            )}
            {ai.messages.length > 0 && (
              <button className="icon-btn sm" title="New conversation" onClick={() => !ai.busy && ai.set({ messages: [] })}>
                <Plus size={16} />
              </button>
            )}
            <button className={`icon-btn sm ${showInstr ? 'active' : ''}`} title={instructions.trim() ? 'Your instructions (in use)' : 'Add your own instructions for every answer'} onClick={() => setShowInstr((o) => !o)} style={{ position: 'relative' }}>
              <ScrollText size={15} />
              {instructions.trim() && <span className="ai-dot" />}
            </button>
            <button className="icon-btn sm" title="AI settings" onClick={() => openSettings('ai')}>
              <Settings2 size={15} />
            </button>
            <button className="icon-btn sm" title="Close (Ctrl+J)" onClick={() => setAiOpen(false)}>
              <X size={16} />
            </button>
          </div>
        </div>

        {findOpen && (
          <div className="ai-find">
            <Search size={14} />
            <input autoFocus placeholder="Search this conversation" value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (setFindOpen(false), setFind(''))} />
            <button className="icon-btn sm" onClick={() => (setFindOpen(false), setFind(''))}>
              <X size={14} />
            </button>
          </div>
        )}

        {showInstr && <InstructionsBox onClose={() => setShowInstr(false)} />}

        {/* Context box */}
        <div className="ai-context">
          <div className="ai-context-head">
            <div className="seg small">
              <button className={scope === 'selection' ? 'on' : ''} disabled={!selection} onClick={() => ai.set({ scope: 'selection', scopeChosen: true })}>
                Selection
              </button>
              <button className={scope === 'document' ? 'on' : ''} onClick={() => ai.set({ scope: 'document', scopeChosen: true })}>
                Whole {noun}
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {selection && (
                <button
                  className={`icon-btn sm ${ai.pinned ? 'active' : ''}`}
                  title={ai.pinned ? 'Unpin (follow new highlights)' : 'Pin this text'}
                  onClick={() => ai.set(ai.pinned ? { pinned: false, pinnedText: null, pinnedTab: null } : { pinned: true, pinnedText: selection, pinnedTab: activeId })}
                >
                  {ai.pinned ? <Pin size={14} /> : <PinOff size={14} />}
                </button>
              )}
              {selection && (
                <button
                  className="icon-btn sm"
                  title="Clear"
                  onClick={() => {
                    const sel = { ...useAi.getState().selections };
                    delete sel[activeId];
                    ai.set({ selections: sel, pinned: false, pinnedText: null, scope: 'document' });
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
          {scope === 'selection' && selection ? (
            <>
              <div className="ai-context-text">{selection}</div>
              <div className="ai-context-meta">
                {wordCount(selection)} words {ai.pinned ? '· pinned' : '· updates when you highlight something else'}
              </div>
            </>
          ) : (
            <div className="ai-context-empty">
              {hooks ? (
                <>
                  Using the whole {noun}: <b>{docName}</b>
                  <div className="ai-context-meta">Highlight text in the {noun} to focus on just that part.</div>
                </>
              ) : (
                'Open a document, PDF, sheet or presentation to use AI.'
              )}
            </div>
          )}
        </div>

        {/* Quick options */}
        <div className="ai-chips">
          <button className="ai-chip" onClick={explain} disabled={!!ai.busy} title="Alt+1">
            <Lightbulb size={15} /> Explain
          </button>
          <button className="ai-chip" onClick={summarize} disabled={!!ai.busy} title="Alt+2">
            <ListCollapse size={15} /> Summarize
          </button>
          <button className="ai-chip" onClick={suggest} disabled={!!ai.busy} title="Alt+3">
            <Wand2 size={15} /> Suggest edits
          </button>
          <MenuButton
            title="Study: flashcards and practice quizzes"
            button={(open) => (
              <button className={`ai-chip ${open ? 'on' : ''}`} disabled={!!ai.busy}>
                <GraduationCap size={15} /> Study
              </button>
            )}
          >
            {(close) => <StudyMenu close={close} onCards={flashcards} onQuiz={quiz} />}
          </MenuButton>
        </div>
        <div className="ai-editmode">
          <span className="muted">Depth</span>
          <button
            className={`ai-wiki ${wikiOn ? 'on' : ''}`}
            role="switch"
            aria-checked={wikiOn}
            title={wikiOn ? 'Checking Wikipedia for up-to-date facts (Explain and questions). Only the topic words are sent.' : 'Off: answers come only from your file and the AI on this PC. Turn on to check Wikipedia for up-to-date facts.'}
            onClick={() => useSettings.getState().set({ 'ai.wikipedia': !wikiOn })}
          >
            <Globe size={13} /> Wikipedia
          </button>
          <div className="seg small" role="radiogroup" aria-label="How detailed answers are">
            {DEPTHS.map((d) => (
              <button key={d.id} role="radio" aria-checked={depth === d.id} className={depth === d.id ? 'on' : ''} title={d.help} onClick={() => useSettings.getState().set({ 'ai.depth': d.id })}>
                {d.label}
              </button>
            ))}
          </div>
        </div>
        {canEdit && (
          <div className="ai-editmode">
            <span className="muted">AI edits</span>
            <div className="seg small" role="radiogroup" aria-label="How AI edits are applied">
              {EDIT_MODES.map((m) => (
                <button
                  key={m.id}
                  role="radio"
                  aria-checked={editMode === m.id}
                  className={editMode === m.id ? 'on' : ''}
                  title={m.help}
                  onClick={() => useSettings.getState().set({ 'ai.editMode': m.id })}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Conversation */}
        <div className="ai-list" ref={listRef}>
          {!ready && ai.state && <ModelSetup />}
          {ready && ai.messages.length === 0 && (
            <div className="ai-empty">
              <Sparkles size={28} />
              <div>Highlight something, then ask about it. Or ask about the whole {noun}.</div>
              <div className="muted">Everything runs on your computer. Nothing is uploaded.</div>
            </div>
          )}
          {visible.map((m) => (
            <MessageView key={m.id} m={m} hooks={hooks} highlight={findOpen ? find : ''} />
          ))}
          {status && (
            <div className="ai-status">
              <span className="dot-pulse" /> {status}
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="ai-composer">
          <textarea
            ref={inputRef}
            rows={2}
            value={input}
            placeholder={ready ? (scope === 'selection' && selection ? 'Ask about the highlighted text…' : `Ask about this ${noun}…`) : ai.state ? 'Download a model to start' : 'Starting AI…'}
            disabled={!ready}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {ai.busy ? (
            <button className="ai-send stop" title="Stop" onClick={stop}>
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button className="ai-send" title="Send (Enter)" disabled={!input.trim() || !ready} onClick={send}>
              <Send size={16} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

function MessageView({ m, hooks, highlight }: { m: AiMessage; hooks: any; highlight: string }) {
  if (m.role === 'user') {
    return (
      <div className="ai-msg user">
        <div className="ai-bubble">{m.text}</div>
        {m.context && <div className="ai-msg-ctx">{m.context}</div>}
      </div>
    );
  }
  if (m.kind === 'flashcards' && m.data) return <FlashcardsView cards={m.data} title={(useTabs.getState().tabs.find((t) => t.id === useTabs.getState().activeId)?.name || 'Study').replace(/\.[^.]+$/, '')} hooks={hooks} />;
  if (m.kind === 'quiz' && m.data) return <QuizView questions={m.data} hooks={hooks} />;
  if (m.kind === 'suggestions' && m.data) return <SuggestionsReport list={m.data} hooks={hooks} initial={m.applied} how={m.appliedHow} />;
  const html = markdownToHtml(m.text || '');
  const marked = highlight ? html.replace(new RegExp(`(${highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![^<]*>)`, 'gi'), '<mark>$1</mark>') : html;
  return (
    <div className={`ai-msg assistant ${m.error ? 'error' : ''}`}>
      {m.streaming && !m.text ? (
        <div className="ai-thinking">
          <span className="dot-pulse" /> Thinking…
        </div>
      ) : (
        <div className="ai-md" dangerouslySetInnerHTML={{ __html: marked + (m.streaming ? '<span class="ai-caret"></span>' : '') }} />
      )}
      {!m.streaming && (m.wiki?.length || m.wikiNote) ? (
        <div className="ai-wiki-src">
          <Globe size={13} />
          {m.wiki?.length ? (
            <span>
              Checked on Wikipedia:{' '}
              {m.wiki.map((w, i) => (
                <span key={w.url}>
                  {i > 0 && ', '}
                  <a href={w.url} target="_blank" rel="noreferrer" title={w.edited ? `Last edited ${w.edited.slice(0, 10)}` : undefined}>
                    {w.title}
                  </a>
                </span>
              ))}
            </span>
          ) : (
            <span className="muted">{m.wikiNote}</span>
          )}
        </div>
      ) : null}
      {m.replaced && (
        <div className="ai-applied">
          <Check size={13} /> {m.replaced === 'track' ? 'Added to the document as a suggestion to accept or reject.' : 'Replaced the highlighted text. Ctrl+Z to undo.'}
        </div>
      )}
      {!m.streaming && !m.error && m.text && (
        <div className="ai-actions">
          {hooks?.replaceSelection && !m.replaced && (
            <button className="btn sm tonal" title="Replace the highlighted text" onClick={() => (hooks.replaceSelection(markdownToPlain(m.text)) ? toast('Replaced. Ctrl+Z to undo.', 'success') : toast('Highlight the text to replace first.'))}>
              <Replace size={13} /> Replace
            </button>
          )}
          {hooks?.insertText && (
            <button className="btn sm tonal" onClick={() => (hooks.insertText(m.text) ? toast('Inserted. Ctrl+Z to undo.', 'success') : toast("Couldn't insert here."))}>
              <CornerDownLeft size={13} /> {hooks.insertLabel || 'Insert'}
            </button>
          )}
          <button className="icon-btn sm" title="Copy" onClick={() => navigator.clipboard.writeText(markdownToPlain(m.text)).then(() => toast('Copied', 'success'))}>
            <Copy size={14} />
          </button>
          {m.retry && (
            <button className="icon-btn sm" title="Try again" onClick={m.retry}>
              <RotateCcw size={14} />
            </button>
          )}
          {m.speed ? <span className="ai-speed">{m.speed.toFixed(0)} tok/s</span> : null}
        </div>
      )}
      {m.error && m.retry && (
        <div className="ai-actions">
          <button className="btn sm tonal" onClick={m.retry}>
            <RotateCcw size={13} /> Try again
          </button>
        </div>
      )}
    </div>
  );
}

/** The user's standing instructions, added to every request (saved in settings). */
export function InstructionsBox({ onClose }: { onClose?: () => void }) {
  const saved = useSettings((s) => String(s.values['ai.instructions'] || ''));
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  const save = (v: string) => useSettings.getState().set({ 'ai.instructions': v });
  return (
    <div className="ai-instr">
      <div className="ai-instr-head">
        <span>Your instructions for every answer</span>
        {onClose && (
          <button className="icon-btn sm" title="Close" onClick={onClose}>
            <X size={14} />
          </button>
        )}
      </div>
      <textarea
        rows={4}
        value={text}
        maxLength={2000}
        placeholder={'e.g. "I\u2019m a medical student: use clinical terminology and explain physiological mechanisms in detail." or "Answer in Spanish." or "Use British spelling."'}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== saved && save(text)}
      />
      <div className="ai-instr-foot">
        <span className="muted">{text.trim() ? 'Used for every request until you clear it.' : 'Nothing set.'}</span>
        <span style={{ display: 'flex', gap: 6 }}>
          {text && (
            <button className="btn sm" onClick={() => (setText(''), save(''))}>
              Clear
            </button>
          )}
          <button className="btn sm tonal" disabled={text === saved} onClick={() => (save(text), toast('Instructions saved', 'success'))}>
            Save
          </button>
        </span>
      </div>
    </div>
  );
}

/** Study menu: what to make, plus how many and how hard (remembered in settings). */
function StudyMenu({ close, onCards, onQuiz }: { close(): void; onCards(): void; onQuiz(): void }) {
  const v = useSettings((s) => s.values);
  const set = (k: string, val: any) => useSettings.getState().set({ [k]: val });
  return (
    <div className="study-menu">
      <button className="menu-item" onClick={() => (close(), onCards())}>
        <Layers size={16} /> Flashcards
      </button>
      <button className="menu-item" onClick={() => (close(), onQuiz())}>
        <ListChecks size={16} /> Practice quiz
      </button>
      <div className="menu-sep" />
      <div className="study-opts">
        <label>
          Cards
          <select className="select sm" value={v['ai.flashcardCount'] ?? 10} onChange={(e) => set('ai.flashcardCount', Number(e.target.value))}>
            {[5, 10, 15, 20, 30].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          Questions
          <select className="select sm" value={v['ai.quizCount'] ?? 5} onChange={(e) => set('ai.quizCount', Number(e.target.value))}>
            {[3, 5, 10, 15, 20].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          Level
          <select className="select sm" value={v['ai.studyDifficulty'] ?? 'medium'} onChange={(e) => set('ai.studyDifficulty', e.target.value)}>
            <option value="easy">Easy (recall)</option>
            <option value="medium">Medium (understand)</option>
            <option value="hard">Hard (apply)</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function SuggestionsReport({ list, hooks, initial, how }: { list: Suggestion[]; hooks: any; initial?: number[]; how?: 'direct' | 'track' }) {
  const [applied, setApplied] = useState<Set<number>>(() => new Set(initial || []));
  return (
    <div className="ai-msg assistant">
      {how && initial && (
        <div className="ai-applied">
          <Check size={13} />
          {how === 'track'
            ? ` ${initial.length} of ${list.length} edits added to the document as suggestions.`
            : ` Made ${initial.length} of ${list.length} edits. Ctrl+Z undoes them.`}
          {initial.length < list.length && ' The rest couldn’t be matched to the text; apply them below.'}
        </div>
      )}
      <div className="grade">
        {list.map((s, i) => (
          <div key={i} className={`sugg ${applied.has(i) ? 'done' : ''}`}>
            <button className="evidence" title="Show in document" onClick={() => hooks?.reveal?.(s.quote) || toast("Couldn't find that text in the document.")}>
              “{s.quote}”
            </button>
            {s.issue && <div className="missing">{s.issue}</div>}
            <div className="sugg-new">{s.suggestion}</div>
            <div className="ai-actions">
              {hooks?.replaceQuote && !applied.has(i) && (
                <button
                  className="btn sm tonal"
                  onClick={() => {
                    if (hooks.replaceQuote(s.quote, s.suggestion)) {
                      setApplied(new Set(applied).add(i));
                      toast('Applied. Ctrl+Z to undo.', 'success');
                    } else toast("Couldn't find that exact text anymore.");
                  }}
                >
                  <Check size={13} /> Apply
                </button>
              )}
              <button className="icon-btn sm" title="Copy" onClick={() => navigator.clipboard.writeText(s.suggestion).then(() => toast('Copied', 'success'))}>
                <Copy size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export { askText };

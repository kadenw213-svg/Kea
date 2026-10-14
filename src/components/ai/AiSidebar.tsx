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
  Check
} from 'lucide-react';
import { openSettings } from '../../lib/settings';
import { useAi, setAiOpen, AiMessage } from './aiStore';
import { useTabs, editorRegistry, toast, prompt as askText } from '../../store';
import { api } from '../../lib/api';
import { runExplain, runSummarize, runAsk, runSuggest, TaskContext, TaskCallbacks, wordCount, markdownToHtml, markdownToPlain, Suggestion } from '../../lib/ai';
import { uid } from '../../lib/util';
import { ModelSetup } from './ModelSetup';
import '../../styles/ai.css';

let cancelFlag = { cancelled: false };

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
  const hooks = editorRegistry.get(activeId)?.ai;

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
  const run = async (label: string, userText: string, task: (ctx: TaskContext, cb: TaskCallbacks) => Promise<any>, kind: AiMessage['kind'] = 'text') => {
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
    const retry = () => run(label, userText, task, kind);
    push({ id: aid, role: 'assistant', text: '', kind, streaming: true, retry });
    cancelFlag = { cancelled: false };
    const flag = cancelFlag;
    useAi.getState().set({ busy: aid });
    setStatus(kind === 'text' ? '' : 'Starting…');
    try {
      const result = await task(ctx, {
        onToken: (full) => patch(aid, { text: full }),
        onStatus: (s) => setStatus(s),
        onRequest: (id) => patch(aid, { requestId: id }),
        cancelled: () => flag.cancelled
      });
      if (kind === 'suggestions') {
        if (result.length) patch(aid, { data: result, streaming: false, text: '' });
        else patch(aid, { kind: 'text', streaming: false, text: 'This reads well already. I have no specific edits to suggest.' });
      } else patch(aid, { streaming: false, text: result.text, speed: result.tokensPerSecond });
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

  const explain = () => run('explain', 'Explain this', runExplain);
  const summarize = () => run('summarize', 'Summarize this', runSummarize);
  const suggest = () => run('suggest', 'Suggest edits', runSuggest, 'suggestions');
  const send = () => {
    const q = input.trim();
    if (!q) return;
    setInput('');
    const history = useAi
      .getState()
      .messages.filter((m) => !m.error && !m.streaming && (m.kind || 'text') === 'text' && m.text)
      .slice(-6)
      .map((m) => ({ role: m.role, text: m.role === 'user' ? m.text : m.text.slice(0, 2000) }));
    run('ask', q, (ctx, cb) => runAsk(q, history, ctx, cb));
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
        </div>

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
  if (m.kind === 'suggestions' && m.data) return <SuggestionsReport list={m.data} hooks={hooks} />;
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
      {!m.streaming && !m.error && m.text && (
        <div className="ai-actions">
          {hooks?.replaceSelection && (
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

function SuggestionsReport({ list, hooks }: { list: Suggestion[]; hooks: any }) {
  const [applied, setApplied] = useState<Set<number>>(new Set());
  return (
    <div className="ai-msg assistant">
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

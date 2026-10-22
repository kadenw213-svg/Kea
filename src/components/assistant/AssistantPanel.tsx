import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, X, Settings2, Trash2, Square, ArrowUp, Eye, Check, AlertCircle, ChevronRight, KeyRound, ExternalLink, Wrench } from 'lucide-react';
import MarkdownIt from 'markdown-it';
import { openSettings, setting, useSettings } from '../../lib/settings';
import { useTabs, editorRegistry, toast } from '../../store';
import { api } from '../../lib/api';
import { ask, stop, clear } from '../../lib/assistant';
import { useAssistant, setAssistantOpen, emptyChat, type ChatItem } from './assistantStore';
import '../../styles/ai.css';
import '../../styles/assistant.css';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
// Links in answers open in the browser, not inside Kea.
md.renderer.rules.link_open = (tokens, i, options, _env, self) => {
  tokens[i].attrSet('target', '_blank');
  return self.renderToken(tokens, i, options);
};
const NAMES: Record<string, string> = {
  read_document: 'Read the file',
  replace_text: 'Replaced text',
  insert_text: 'Inserted text',
  replace_selection: 'Replaced the selection',
  add_comment: 'Commented',
  show_in_document: 'Showed a passage',
  look: 'Looked at it'
};
const stepName = (n = '') => NAMES[n] || n.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The Claude Assistant (Ctrl+Shift+J): talk to Claude about the open file, and let it read and edit it. */
export function AssistantPanel() {
  const open = useAssistant((s) => s.open);
  const key = useAssistant((s) => s.key);
  const activeId = useTabs((s) => s.activeId);
  const tab = useTabs((s) => s.tabs.find((t) => t.id === s.activeId));
  const chat = useAssistant((s) => s.chats[activeId]) || emptyChat();
  const hooks = editorRegistry.get(activeId)?.ai;
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const model = useSettings((s) => s.values['assistant.model']) || 'claude-opus-5-5';

  useEffect(() => {
    if (open && !key) api.assistant.status().then((k) => useAssistant.getState().set({ key: k }));
  }, [open, key]);
  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [chat.items]);
  useEffect(() => {
    if (open) setTimeout(() => boxRef.current?.focus(), 50);
  }, [open, activeId]);

  const send = () => {
    const t = input.trim();
    if (!t || chat.busy) return;
    setInput('');
    ask(activeId, t);
  };
  const usable = tab && tab.kind !== 'home';

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = Number(useSettings.getState().values['ai.sidebarWidth']) || 380;
    document.body.classList.add('col-resizing');
    const move = (ev: PointerEvent) => useSettings.getState().set({ 'ai.sidebarWidth': Math.round(Math.min(640, Math.max(300, startW + (startX - ev.clientX)))) });
    const up = () => {
      document.body.classList.remove('col-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <aside className={`ai-sidebar assistant ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div className="ai-resize" title="Drag to resize" onPointerDown={startResize} onDoubleClick={() => useSettings.getState().set({ 'ai.sidebarWidth': 380 })} />
      <div className="ai-inner">
        <div className="ai-head">
          <div className="ai-title">
            <Sparkles size={17} />
            <span>Claude</span>
            <span className="as-model">{model.replace('claude-', '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-(\d)$/, ' $1')}</span>
          </div>
          <div style={{ display: 'flex' }}>
            {chat.items.length > 0 && (
              <button className="icon-btn sm" title="New conversation" onClick={() => clear(activeId)}>
                <Trash2 size={15} />
              </button>
            )}
            <button className="icon-btn sm" title="Assistant settings" onClick={() => openSettings('assistant')}>
              <Settings2 size={15} />
            </button>
            <button className="icon-btn sm" title="Close (Ctrl+Shift+J)" onClick={() => setAssistantOpen(false)}>
              <X size={16} />
            </button>
          </div>
        </div>

        {key && !key.hasKey ? (
          <KeySetup />
        ) : (
          <>
            <div className="ai-list as-list" ref={listRef}>
              {!chat.items.length && (
                <div className="ai-empty">
                  <Sparkles size={28} />
                  <div>{usable ? `Ask Claude about this ${hooks?.noun || 'file'}, or tell it what to change.` : 'Open a file to work on it with Claude.'}</div>
                  <div className="muted">
                    Claude reads the {hooks?.noun || 'file'}, makes the changes you ask for with the editor’s own tools, and tells you what it did. Each change is one Ctrl+Z. It uses your own Claude API key{key?.hint ? ` (${key.hint})` : ''}.
                  </div>
                  {usable && hooks && (
                    <div className="as-starters">
                      {starters(hooks.noun).map((s) => (
                        <button key={s} className="ai-chip" onClick={() => ask(activeId, s)}>
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {chat.items.map((it) => (
                <Item key={it.id} it={it} />
              ))}
              {chat.busy && (
                <div className="ai-status">
                  <span className="dot-pulse" /> Working…
                </div>
              )}
            </div>
            <div className="as-foot">
              {chat.usage.input + chat.usage.output > 0 && setting('assistant.showUsage') !== false && (
                <span className="as-usage" title="Tokens this conversation used (cached input costs a tenth)">
                  {fmt(chat.usage.input + chat.usage.cached)} in{chat.usage.cached ? ` (${fmt(chat.usage.cached)} cached)` : ''} · {fmt(chat.usage.output)} out
                </span>
              )}
            </div>
            <div className="ai-composer">
              <textarea
                ref={boxRef}
                rows={1}
                value={input}
                disabled={!usable}
                placeholder={usable ? `Message Claude about this ${hooks?.noun || 'file'}…` : 'Open a file first'}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  } else if (e.key === 'Escape' && chat.busy) stop(activeId);
                }}
              />
              {hooks && !chat.busy && (
                <button className="icon-btn sm" title="Send with a picture of what you see" disabled={!input.trim()} onClick={() => (ask(activeId, input.trim(), { look: true }), setInput(''))}>
                  <Eye size={16} />
                </button>
              )}
              {chat.busy ? (
                <button className="ai-send" title="Stop (Esc)" onClick={() => stop(activeId)}>
                  <Square size={14} />
                </button>
              ) : (
                <button className="ai-send" title="Send (Enter)" disabled={!input.trim() || !usable} onClick={send}>
                  <ArrowUp size={17} />
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function starters(noun: string): string[] {
  switch (noun) {
    case 'document':
      return ['Proofread this and fix mistakes', 'Summarize it in five bullet points', 'Make the introduction stronger'];
    case 'spreadsheet':
      return ['Explain what this sheet does', 'Add a totals row', 'Find anything that looks wrong'];
    case 'presentation':
      return ['Tighten the wording on every slide', 'Add speaker notes', 'Suggest a slide that’s missing'];
    case 'PDF':
      return ['Summarize this PDF', 'What are the key terms?', 'Comment on anything unclear'];
    case 'image':
      return ['Make it look more vivid', 'Crop it to a square', 'Turn it black and white'];
    case 'video':
      return ['Trim the dead air at the start', 'Add a title at the beginning', 'Describe what’s on the timeline'];
    default:
      return ['Explain this file', 'Find bugs or mistakes', 'Clean it up'];
  }
}

function Item({ it }: { it: ChatItem }) {
  const [open, setOpen] = useState(false);
  const html = useMemo(() => (it.kind === 'assistant' || it.kind === 'thinking' ? md.render(it.text) : ''), [it.kind, it.text]);
  if (it.kind === 'user')
    return (
      <div className="ai-msg user">
        {it.image && <img className="as-shot" src={it.image} alt="What Claude was shown" />}
        <div className="ai-bubble">{it.text}</div>
      </div>
    );
  if (it.kind === 'assistant')
    return (
      <div className="ai-msg assistant">
        <div className="ai-md" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    );
  if (it.kind === 'thinking')
    return (
      <div className={`as-think ${open ? 'open' : ''}`}>
        <button className="as-think-head" onClick={() => setOpen(!open)}>
          <ChevronRight size={13} /> Reasoning
        </button>
        {open && <div className="ai-md" dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
    );
  if (it.kind === 'tool')
    return (
      <div className={`as-step ${it.ok === false ? 'bad' : it.ok ? 'ok' : ''}`} title={it.text}>
        <button className="as-step-head" onClick={() => setOpen(!open)}>
          {it.ok === undefined ? <span className="dot-pulse" /> : it.ok ? <Check size={13} /> : <AlertCircle size={13} />}
          <Wrench size={12} className="as-step-icon" />
          <span className="as-step-name">{stepName(it.name)}</span>
          {it.ok === false && <span className="as-step-err">{it.result}</span>}
        </button>
        {open && (
          <div className="as-step-body">
            {it.text && <div className="as-step-in">{it.text}</div>}
            {it.result && it.ok && <div className="as-step-out">{it.result}</div>}
          </div>
        )}
        {it.image && <img className="as-shot" src={it.image} alt="What Claude saw" />}
      </div>
    );
  return (
    <div className="ai-msg error">
      <div className="ai-md">{it.text}</div>
    </div>
  );
}

/** First run: the student pastes their Claude API key; Kea checks it before keeping it. */
function KeySetup() {
  const [k, setK] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const save = async () => {
    setBusy(true);
    setErr('');
    const r = await api.assistant.setKey(k.trim());
    setBusy(false);
    if (!r.ok) return setErr(r.error || 'That key didn’t work.');
    setK('');
    useAssistant.getState().set({ key: await api.assistant.status() });
    toast('Claude is connected', 'success');
  };
  return (
    <div className="as-setup">
      <KeyRound size={28} />
      <div className="as-setup-title">Connect Claude</div>
      <div className="muted">
        Paste an API key from your Anthropic account. Kea keeps it encrypted on this computer and sends it only to Claude. You pay Anthropic for what you use; the panel shows how much each conversation took.
      </div>
      <input className="input" type="password" placeholder="sk-ant-…" value={k} onChange={(e) => setK(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && k.trim() && save()} autoFocus />
      {err && <div className="as-err">{err}</div>}
      <div className="as-setup-actions">
        <button className="btn primary sm" disabled={!k.trim() || busy} onClick={save}>
          {busy ? 'Checking…' : 'Connect'}
        </button>
        <a className="btn sm text" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
          Get a key <ExternalLink size={13} />
        </a>
      </div>
    </div>
  );
}

/** Toolbar button that opens/closes the Claude panel. */
export function AssistantButton() {
  const open = useAssistant((s) => s.open);
  const on = useSettings((s) => s.values['assistant.enabled']) !== false;
  if (!on) return null;
  return (
    <button className={`ai-toolbar-btn ${open ? 'on' : ''}`} title="Claude: ask about this file or have it make changes (Ctrl+Shift+J)" onMouseDown={(e) => e.preventDefault()} onClick={() => setAssistantOpen(!open)}>
      <Sparkles size={15} /> Claude
    </button>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, X, Settings2, Trash2, Square, ArrowUp, Eye, Check, AlertCircle, ChevronRight, KeyRound, ExternalLink, Wrench, Paperclip, FileText, Gauge, RefreshCw, LogIn } from 'lucide-react';
import MarkdownIt from 'markdown-it';
import { openSettings, setting, useSettings } from '../../lib/settings';
import { useTabs, editorRegistry, toast } from '../../store';
import { api, type PlanUsage } from '../../lib/api';
import { ask, stop, clear } from '../../lib/assistant';
import { addAttachment, isAttachable, ATTACHABLE, type Attachment } from '../../lib/attachments';
import { useAssistant, setAssistantOpen, emptyChat, INTERNAL_STEPS, type ChatItem } from './assistantStore';
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
  const onPlan = useSettings((s) => s.values['assistant.provider']) !== 'api';
  const showBars = useSettings((s) => s.values['assistant.usageBars']) !== false;
  const [plan, setPlan] = useState<{ installed: boolean; loggedIn: boolean; email: string; plan: string } | null>(null);
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  // Files waiting to go with the next message (a flier to recreate, concept images, a PDF brief).
  const [pending, setPending] = useState<Attachment[]>([]);
  const [dropHere, setDropHere] = useState(false);

  useEffect(() => {
    if (open && !key) api.assistant.status().then((k) => useAssistant.getState().set({ key: k }));
  }, [open, key]);
  // On the Claude plan: is Claude Code there and signed in, and the plan's latest usage.
  useEffect(() => {
    if (!open || !onPlan) return;
    api.assistant.planStatus().then(setPlan);
    api.assistant.planUsage().then((u) => u && setUsage(u));
    return api.assistant.onPlanUsage(setUsage);
  }, [open, onPlan]);
  useEffect(() => {
    const el = listRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [chat.items]);
  useEffect(() => {
    if (open) setTimeout(() => boxRef.current?.focus(), 50);
  }, [open, activeId]);

  const send = (look?: boolean) => {
    const t = input.trim();
    if ((!t && !pending.length) || chat.busy) return;
    setInput('');
    setPending([]);
    ask(activeId, t, { attachments: pending, ...(look ? { look: true } : {}) });
  };
  const usable = tab && tab.kind !== 'home';
  const canSend = usable && (!!input.trim() || pending.length > 0);

  const attach = async (files: { name: string; data: Uint8Array | Blob }[]) => {
    const added: Attachment[] = [];
    for (const f of files) {
      if (!isAttachable(f.name)) {
        toast(`${f.name}: Claude can be given images and PDFs.`, 'error');
        continue;
      }
      try {
        added.push(await addAttachment(f.name, f.data));
      } catch (err: any) {
        toast(err.message || String(err), 'error');
      }
    }
    if (added.length) setPending((p) => [...p, ...added]);
    boxRef.current?.focus();
  };
  const pickFiles = async () => {
    const files = await api.openDialog({ title: 'Give Claude a file', multi: true, filters: [{ name: 'Images and PDFs', extensions: ATTACHABLE }] });
    if (files.length) attach(files);
  };
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  // While files are dragged over the panel, the window's "Drop to open" cover steps aside.
  useEffect(() => {
    document.body.classList.toggle('drop-to-claude', dropHere);
  }, [dropHere]);

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
    <aside
      className={`ai-sidebar assistant ${open ? 'open' : ''} ${dropHere ? 'drop-here' : ''}`}
      aria-hidden={!open}
      onDragOver={(e) => {
        if (!hasFiles(e) || !usable) return;
        e.preventDefault();
        e.stopPropagation();
        setDropHere(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropHere(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e) || !usable) return;
        // Files dropped here go to Claude instead of opening as tabs (the window's drop handler sees the flag and only
        // clears its cover).
        e.preventDefault();
        (e.nativeEvent as any).keaTaken = true;
        setDropHere(false);
        attach(Array.from(e.dataTransfer.files).map((f) => ({ name: f.name, data: f })));
      }}
    >
      {dropHere && <div className="as-drop">Drop to give Claude {usable ? 'these files' : ''}</div>}
      <div className="ai-resize" title="Drag to resize" onPointerDown={startResize} onDoubleClick={() => useSettings.getState().set({ 'ai.sidebarWidth': 380 })} />
      <div className="ai-inner">
        <div className="ai-head">
          <div className="ai-title">
            <Sparkles size={17} />
            <span>Claude</span>
            <span className="as-model" title={onPlan ? `On your Claude plan${plan?.email ? ` (${plan.email})` : ''}` : 'On your API key'}>
              {model.replace('claude-', '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-(\d)$/, ' $1')} · {onPlan ? 'plan' : 'API'}
            </span>
          </div>
          <div style={{ display: 'flex' }}>
            {chat.items.length > 0 && (
              <button className="icon-btn sm" title="New conversation" onClick={() => clear(activeId)}>
                <Trash2 size={15} />
              </button>
            )}
            {onPlan && (
              <button className={`icon-btn sm ${showBars ? 'on' : ''}`} title={showBars ? 'Hide plan usage' : 'Show your plan’s 5-hour and weekly usage'} onClick={() => useSettings.getState().set({ 'assistant.usageBars': !showBars })}>
                <Gauge size={15} />
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

        {onPlan && plan && (!plan.installed || !plan.loggedIn) ? (
          <PlanSetup installed={plan.installed} onDone={() => api.assistant.planStatus().then(setPlan)} />
        ) : !onPlan && key && !key.hasKey ? (
          <KeySetup />
        ) : (
          <>
            <div className="ai-list as-list" ref={listRef}>
              {!chat.items.length && (
                <div className="ai-empty">
                  <Sparkles size={28} />
                  <div>{usable ? `Ask Claude about this ${hooks?.noun || 'file'}, or tell it what to change.` : 'Open a file to work on it with Claude.'}</div>
                  <div className="muted">
                    Claude reads the {hooks?.noun || 'file'}, makes the changes you ask for with the editor’s own tools, and tells you what it did. Each change is one Ctrl+Z. {onPlan ? 'It runs on your own Claude plan.' : `It uses your own Claude API key${key?.hint ? ` (${key.hint})` : ''}.`}
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
              {setting('assistant.showSteps')
                ? chat.items.map((it) => <Item key={it.id} it={it} />)
                : group(chat.items, chat.busy).map((g) => (g.steps ? <Steps key={g.key} items={g.steps} live={g.live} tabId={activeId} /> : <Item key={g.key} it={g.it!} />))}
              {chat.busy && setting('assistant.showSteps') && (
                <div className="ai-status">
                  <span className="dot-pulse" /> Working…
                </div>
              )}
            </div>
            {onPlan && showBars && <UsageBars usage={usage} onRefresh={async () => setUsage(await api.assistant.planUsageRefresh())} />}
            <div className="as-foot">
              {chat.usage.input + chat.usage.output > 0 && setting('assistant.showUsage') !== false && (
                <span className="as-usage" title="Tokens this conversation used (cached input costs a tenth)">
                  {fmt(chat.usage.input + chat.usage.cached)} in{chat.usage.cached ? ` (${fmt(chat.usage.cached)} cached)` : ''} · {fmt(chat.usage.output)} out
                </span>
              )}
            </div>
            {pending.length > 0 && (
              <div className="as-pending">
                {pending.map((a) => (
                  <div key={a.id} className="as-file" title={a.name}>
                    {a.mime.startsWith('image/') ? <img src={a.dataUrl} alt="" /> : <FileText size={16} />}
                    <span>{a.name}</span>
                    <button className="icon-btn sm" title="Remove" onClick={() => setPending((p) => p.filter((x) => x.id !== a.id))}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="ai-composer">
              {usable && !chat.busy && (
                <button className="icon-btn sm" title="Attach an image or PDF: a flier to recreate, concept art, a brief (or paste / drop it here)" onClick={pickFiles}>
                  <Paperclip size={16} />
                </button>
              )}
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
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf');
                  if (!files.length) return;
                  e.preventDefault();
                  attach(files.map((f, i) => ({ name: f.name && f.name !== 'image.png' ? f.name : `pasted-${Date.now().toString(36)}${i || ''}.${f.type === 'application/pdf' ? 'pdf' : f.type.split('/')[1].replace('jpeg', 'jpg')}`, data: f })));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  } else if (e.key === 'Escape' && chat.busy) stop(activeId);
                }}
              />
              {hooks && !chat.busy && (
                <button className="icon-btn sm" title="Send with a picture of what you see" disabled={!canSend} onClick={() => send(true)}>
                  <Eye size={16} />
                </button>
              )}
              {chat.busy ? (
                <button className="ai-send" title="Stop (Esc)" onClick={() => stop(activeId)}>
                  <Square size={14} />
                </button>
              ) : (
                <button className="ai-send" title="Send (Enter)" disabled={!canSend} onClick={() => send()}>
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
      return ['Tighten the wording on every slide', 'Add speaker notes', 'Redesign this slide so it looks professional'];
    case 'PDF':
      return ['Summarize this PDF', 'Highlight the key terms', 'Comment on anything unclear'];
    case 'image':
      return ['Make it look more vivid', 'Crop it to a square', 'Turn it black and white'];
    case 'video':
      return ['Trim the dead air at the start', 'Add a title at the beginning', 'Describe what’s on the timeline'];
    default:
      return ['Explain this file', 'Find bugs or mistakes', 'Clean it up'];
  }
}

/**
 * What the chat shows of each answer: the student's message, one folded line for all the work in between (steps,
 * reasoning, progress notes), then Claude's final message and any error. The file itself shows the work happening.
 */
function group(items: ChatItem[], busy: boolean): { key: string; it?: ChatItem; steps?: ChatItem[]; live?: boolean }[] {
  const out: { key: string; it?: ChatItem; steps?: ChatItem[]; live?: boolean }[] = [];
  const turns: ChatItem[][] = [];
  for (const it of items) {
    if (it.kind === 'user' || !turns.length) turns.push([]);
    turns[turns.length - 1].push(it);
  }
  turns.forEach((turn, ti) => {
    const last = ti === turns.length - 1;
    const live = last && busy;
    let final = -1;
    if (!live) for (let i = turn.length - 1; i >= 0; i--) if (turn[i].kind === 'assistant') {
      final = i;
      break;
    }
    const work: ChatItem[] = [];
    const after: ChatItem[] = [];
    turn.forEach((it, i) => {
      if (it.kind === 'user') out.push({ key: it.id, it });
      else if (it.kind === 'error') after.push(it);
      else if (i === final) after.unshift(it);
      else work.push(it);
    });
    if (work.length || live) out.push({ key: `steps-${turn[0].id}`, steps: work, live });
    for (const it of after) out.push({ key: it.id, it });
  });
  return out;
}

function Steps({ items, live, tabId }: { items: ChatItem[]; live?: boolean; tabId: string }) {
  const [open, setOpen] = useState(false);
  const activity = useAssistant((s) => s.activity[tabId]);
  const tools = items.filter((i) => i.kind === 'tool');
  const edits = tools.filter((i) => !INTERNAL_STEPS.has(i.name || ''));
  const failed = edits.filter((i) => i.ok === false).length;
  const shown = items.filter((i) => (i.kind === 'tool' ? !INTERNAL_STEPS.has(i.name || '') : i.kind === 'assistant' || (i.kind === 'thinking' && setting('assistant.showThinking'))));
  const label = live ? `${activity || 'Thinking…'}${tools.length ? ` · ${tools.length} step${tools.length === 1 ? '' : 's'}` : ''}` : edits.length ? `Made ${edits.length} change${edits.length === 1 ? '' : 's'}` : tools.length ? 'Looked over the file' : 'Thought it through';
  return (
    <div className={`as-steps ${open ? 'open' : ''}`}>
      <button className="as-steps-head" onClick={() => setOpen(!open)} disabled={!shown.length}>
        {live ? <span className="dot-pulse" /> : <Check size={13} />}
        <span>{label}</span>
        {failed > 0 && !live && <span className="bad">{failed} didn’t work</span>}
        {shown.length > 0 && <ChevronRight size={13} className="chev" />}
      </button>
      {open && (
        <div className="as-steps-body">
          {shown.map((it) => (it.kind === 'assistant' ? <div key={it.id} className="as-note">{it.text}</div> : <Item key={it.id} it={it} />))}
        </div>
      )}
    </div>
  );
}

function Item({ it }: { it: ChatItem }) {
  const [open, setOpen] = useState(false);
  const html = useMemo(() => (it.kind === 'assistant' || it.kind === 'thinking' ? md.render(it.text) : ''), [it.kind, it.text]);
  if (it.kind === 'user')
    return (
      <div className="ai-msg user">
        {it.image && <img className="as-shot" src={it.image} alt="What Claude was shown" />}
        {it.files?.map((f, i) =>
          f.thumb ? (
            <img key={i} className="as-shot" src={f.thumb} alt={f.name} title={f.name} />
          ) : (
            <div key={i} className="as-file sent" title={f.name}>
              <FileText size={16} />
              <span>{f.name}</span>
            </div>
          )
        )}
        {it.text && <div className="ai-bubble">{it.text}</div>}
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

/** The plan's usage windows as bars: the rolling 5-hour window and the week, with when each resets. */
function UsageBars({ usage, onRefresh }: { usage: PlanUsage | null; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60000);
    return () => clearInterval(t);
  }, []);
  const when = (ms: number | null) => {
    if (!ms) return '';
    const left = ms - Date.now();
    if (left <= 0) return 'reset';
    if (left < 36e5) return `resets in ${Math.max(1, Math.round(left / 6e4))} min`;
    if (left < 864e5) return `resets in ${Math.floor(left / 36e5)} h ${Math.round((left % 36e5) / 6e4)} min`;
    return `resets ${new Date(ms).toLocaleDateString(undefined, { weekday: 'short' })} ${new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  };
  const row = (label: string, w: PlanUsage['fiveHour']) => {
    // A window that has reset since the last reading starts again from zero.
    const past = !!w?.resetsAt && w.resetsAt < Date.now();
    const pct = w && !past ? Math.round(w.used * 100) : 0;
    return (
      <div className="as-bar" title={w ? `${pct}% of your plan’s ${label.toLowerCase()} limit used` : 'Not known yet: send a message or refresh'}>
        <div className="as-bar-top">
          <span>{label}</span>
          <span>{w ? `${pct}%${past ? '' : ` · ${when(w.resetsAt)}`}` : '—'}</span>
        </div>
        <div className="as-bar-track">
          <div className={`as-bar-fill ${pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      </div>
    );
  };
  return (
    <div className="as-usage-bars">
      <div className="as-bars">
        {row('5-hour window', usage?.fiveHour || null)}
        {row('Weekly', usage?.week || null)}
      </div>
      <button
        className="icon-btn sm"
        title={`Refresh (sends a tiny message to check)${usage ? `. Last checked ${new Date(usage.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onRefresh().finally(() => setBusy(false));
        }}
      >
        <RefreshCw size={13} className={busy ? 'spin' : ''} />
      </button>
    </div>
  );
}

/** First run on the plan: install Claude Code if needed and sign in with the student's Claude account. */
function PlanSetup({ installed, onDone }: { installed: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <div className="as-setup">
      <LogIn size={28} />
      <div className="as-setup-title">Use your Claude plan</div>
      <div className="muted">
        Kea runs Claude through Claude Code, Anthropic’s official app, signed in with your Claude account, so it uses your Pro or Max plan instead of an API key. {installed ? '' : 'Kea installs it for you first (into your own user folder). '}A sign-in window opens in your browser; come back here when it says you’re signed in.
      </div>
      {err && <div className="as-err">{err}</div>}
      <div className="as-setup-actions">
        <button
          className="btn primary sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr('');
            try {
              const r = await api.assistant.planSignIn();
              if (!r.loggedIn) setErr('Sign-in didn’t finish. Try again.');
            } catch (e: any) {
              setErr(e?.message || String(e));
            }
            setBusy(false);
            onDone();
          }}
        >
          {busy ? (installed ? 'Waiting for sign-in…' : 'Installing and signing in…') : 'Sign in to Claude'}
        </button>
        <button className="btn sm text" onClick={() => useSettings.getState().set({ 'assistant.provider': 'api' })}>
          Use an API key instead
        </button>
      </div>
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
        <button className="btn sm text" onClick={() => useSettings.getState().set({ 'assistant.provider': 'plan' })}>
          Use my Claude plan
        </button>
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

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Mic, MicOff, X, Settings2, Download, Loader2, Pause } from 'lucide-react';
import { api, SpeechModel } from '../lib/api';
import { setting, openSettings, useSettings } from '../lib/settings';
import { toast } from '../store';
import { formatBytes } from '../lib/util';

/**
 * Voice typing, offline. The microphone is split into phrases at natural pauses; each phrase is turned into
 * text by Whisper (in a worker) and typed where the cursor is: documents, slides, cells, text files, any box.
 */
type Status = 'idle' | 'loading' | 'listening' | 'hearing' | 'error';

interface VoiceStore {
  open: boolean;
  status: Status;
  level: number;
  busy: number; // phrases waiting to be turned into text
  loadProgress: number;
  error: string;
  models: SpeechModel[];
  set(p: Partial<VoiceStore>): void;
}
export const useVoice = create<VoiceStore>((set) => ({
  open: false,
  status: 'idle',
  level: 0,
  busy: 0,
  loadProgress: 0,
  error: '',
  models: [],
  set: (p) => set(p)
}));

const SR = 16000;
let worker: Worker | null = null;
let workerRepo = '';
let workerReady: Promise<void> | null = null;
let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let proc: ScriptProcessorNode | null = null;
let target: Element | null = null;
let seq = 0;
let nextToInsert = 0;
const results = new Map<number, string>();
const pending = new Map<number, (text: string) => void>();

const modelId = () => String(setting('voice.model') || 'base');
const currentModel = () => useVoice.getState().models.find((m) => m.id === modelId());

export async function refreshVoiceModels() {
  const models = await api.speech.state();
  useVoice.getState().set({ models });
  return models;
}

function getWorker(repo: string): Promise<void> {
  if (worker && workerRepo === repo && workerReady) return workerReady;
  worker?.terminate();
  worker = new Worker(new URL('../lib/speechWorker.ts', import.meta.url), { type: 'module' });
  workerRepo = repo;
  const w = worker;
  workerReady = new Promise<void>((resolve, reject) => {
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') useVoice.getState().set({ loadProgress: m.progress });
      else if (m.type === 'loaded') resolve();
      else if (m.type === 'result') {
        pending.get(m.id)?.(m.text);
        pending.delete(m.id);
      } else if (m.type === 'error') {
        if (m.id == null) reject(new Error(m.message));
        else {
          console.warn('voice typing', m.message);
          pending.get(m.id)?.('');
          pending.delete(m.id);
        }
      }
    };
    w.onerror = (e) => reject(new Error(e.message || 'The speech engine failed to start.'));
  });
  workerReady.catch(() => {
    worker?.terminate();
    worker = null;
    workerReady = null;
  });
  w.postMessage({ type: 'load', repo });
  return workerReady;
}

const isEditable = (el: Element | null): el is HTMLElement =>
  !!el && el instanceof HTMLElement && (el.isContentEditable || (el.tagName === 'TEXTAREA' && !(el as HTMLTextAreaElement).readOnly) || (el.tagName === 'INPUT' && /^(text|search|email|url|)$/i.test((el as HTMLInputElement).type)));

/** Keep typing wherever the user last put the cursor (but not into the voice panel itself). */
function onFocusIn(e: FocusEvent) {
  const el = e.target as Element;
  if (isEditable(el) && !el.closest('.voice-panel')) target = el;
}

// ---------- Text clean-up and commands ----------
const FILLERS = /\b(um+|uh+|erm+|hmm+|mm+)\b[,.]?\s*/gi;
const HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|you\.?|bye\.?|\.+)$/i;

function clean(text: string, seconds: number) {
  let t = text.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
  if (setting('voice.filterFillers') !== false) t = t.replace(FILLERS, '').trim();
  if (seconds < 2.5 && HALLUCINATIONS.test(t)) return '';
  return t;
}

/** Split text around spoken commands ("new line", "new paragraph"). */
function parts(text: string): (string | { cmd: 'line' | 'para' | 'stop' })[] {
  if (setting('voice.commands') === false) return [text];
  const out: (string | { cmd: 'line' | 'para' | 'stop' })[] = [];
  const re = /\b(new paragraph|next paragraph|new line|next line|stop listening|stop voice typing)\b[.,!]?/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index).trim());
    const w = m[1].toLowerCase();
    out.push({ cmd: w.includes('paragraph') ? 'para' : w.includes('line') ? 'line' : 'stop' });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last).trim());
  return out.filter((p) => p !== '');
}

function charBefore(el: HTMLElement): string {
  const ed = (el.closest('.ProseMirror') as any)?.editor;
  if (ed) {
    const { from } = ed.state.selection;
    return from > 1 ? ed.state.doc.textBetween(Math.max(0, from - 1), from, '\n', '\n') || '\n' : '\n';
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.slice(0, el.selectionStart ?? el.value.length).slice(-1) || '\n';
  const sel = window.getSelection();
  const n = sel?.anchorNode;
  if (n && n.nodeType === Node.TEXT_NODE && sel!.anchorOffset > 0) return (n.textContent || '').charAt(sel!.anchorOffset - 1);
  return '\n';
}

function typeInto(el: HTMLElement, text: string) {
  const ed = (el.closest('.ProseMirror') as any)?.editor;
  if (document.activeElement !== el && !el.contains(document.activeElement)) el.focus();
  if (ed) {
    ed.chain().focus().insertContent(text).run();
    return;
  }
  if (!document.execCommand('insertText', false, text) && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    const s = el.selectionStart ?? el.value.length;
    el.setRangeText(text, s, el.selectionEnd ?? s, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function newLine(el: HTMLElement, para: boolean) {
  const ed = (el.closest('.ProseMirror') as any)?.editor;
  if (ed) {
    ed.chain().focus()[para ? 'splitBlock' : 'setHardBreak']().run();
    return;
  }
  if (el instanceof HTMLInputElement) return; // single-line box
  typeInto(el, para ? '\n\n' : '\n');
}

function insertText(raw: string, seconds: number) {
  const text = clean(raw, seconds);
  if (!text) return;
  const el = target && document.contains(target) ? (target as HTMLElement) : null;
  if (!el) {
    toast('Click where the text should go, then keep talking.');
    return;
  }
  for (const p of parts(text)) {
    if (typeof p !== 'string') {
      if (p.cmd === 'stop') stopVoice();
      else newLine(el, p.cmd === 'para');
      continue;
    }
    const before = charBefore(el);
    let t = p;
    // Lower-case a phrase that continues a sentence ("…and" + "Then we left" → "then we left").
    if (before !== '\n' && !/[.!?:]\s*$/.test(before) && /^[A-Z][a-z]/.test(t) && !/^I\b/.test(t)) t = t[0].toLowerCase() + t.slice(1);
    const space = before === '\n' || /\s/.test(before) || /^[.,!?;:)]/.test(t) ? '' : ' ';
    typeInto(el, space + t);
  }
}

/** Results can finish out of order; type them in the order they were spoken. */
function flushResults() {
  while (results.has(nextToInsert)) {
    const r = results.get(nextToInsert)!;
    results.delete(nextToInsert);
    nextToInsert++;
    const [secs, text] = [Number(r.slice(0, r.indexOf('|'))), r.slice(r.indexOf('|') + 1)];
    insertText(text, secs);
  }
}

function transcribe(audio: Float32Array) {
  const id = seq++;
  const m = currentModel();
  useVoice.getState().set({ busy: useVoice.getState().busy + 1 });
  pending.set(id, (text) => {
    useVoice.getState().set({ busy: Math.max(0, useVoice.getState().busy - 1) });
    results.set(id, `${audio.length / SR}|${text}`);
    flushResults();
  });
  worker!.postMessage({ type: 'transcribe', id, audio, englishOnly: !!m?.englishOnly, language: String(setting('voice.language') || 'auto') }, [audio.buffer]);
}

// ---------- Microphone and phrase detection ----------
export async function startVoice() {
  const st = useVoice.getState();
  if (st.status === 'listening' || st.status === 'hearing' || st.status === 'loading') return;
  const active = document.activeElement;
  if (isEditable(active) && !active.closest('.voice-panel')) target = active;
  st.set({ open: true, error: '' });
  const models = await refreshVoiceModels();
  const m = models.find((x) => x.id === modelId());
  if (!m?.installed) return; // the panel shows the download card
  try {
    st.set({ status: 'loading', loadProgress: 0 });
    await getWorker(m.repo);
    const dev = String(setting('voice.mic') || '');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: dev ? { exact: dev } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: setting('voice.noiseSuppression') !== false,
        autoGainControl: true
      }
    });
  } catch (err: any) {
    const msg = /Permission|NotAllowed/i.test(err?.name + err?.message)
      ? 'Slate isn’t allowed to use the microphone. Turn on Windows Settings → Privacy & security → Microphone → "Let desktop apps access your microphone".'
      : /NotFound|Overconstrained/i.test(err?.name + err?.message)
        ? 'No microphone was found. Plug one in, or pick another one in Settings → Voice typing.'
        : err?.message || String(err);
    st.set({ status: 'error', error: msg });
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    return;
  }
  ctx = new AudioContext({ sampleRate: SR });
  const src = ctx.createMediaStreamSource(stream);
  proc = ctx.createScriptProcessor(2048, 1, 1);
  src.connect(proc);
  proc.connect(ctx.destination);

  const pauseMs = Math.max(200, Number(setting('voice.pause')) || 700);
  const maxSecs = Math.max(5, Number(setting('voice.maxPhrase')) || 20);
  const sensitivity = Math.max(1, Math.min(10, Number(setting('voice.sensitivity')) || 5));
  const idleStop = Math.max(0, Number(setting('voice.idleStop')) ?? 60);
  const FRAME = 512; // 32 ms
  let floor = 0.003;
  let inSpeech = false;
  let silentFrames = 0;
  let speechFrames = 0;
  let lastSpeech = performance.now();
  const pre: Float32Array[] = [];
  let buf: Float32Array[] = [];
  const endPhrase = () => {
    const len = buf.reduce((a, b) => a + b.length, 0);
    // Ignore clicks and coughs: at least ~0.3 s of speech.
    if (speechFrames >= 9) {
      const out = new Float32Array(len);
      let o = 0;
      for (const b of buf) {
        out.set(b, o);
        o += b.length;
      }
      transcribe(out);
    }
    buf = [];
    inSpeech = false;
    silentFrames = 0;
    speechFrames = 0;
  };
  proc.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    let peak = 0;
    for (let off = 0; off < data.length; off += FRAME) {
      const f = data.slice(off, off + FRAME);
      let sum = 0;
      for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
      const rms = Math.sqrt(sum / f.length);
      peak = Math.max(peak, rms);
      // Track background noise slowly; speech is a few times louder than it.
      if (!inSpeech) floor = floor * 0.97 + Math.min(rms, floor * 3) * 0.03;
      const thr = Math.max(0.004 + (10 - sensitivity) * 0.0025, floor * (1.5 + (10 - sensitivity) * 0.25));
      const loud = rms > thr;
      if (loud) {
        lastSpeech = performance.now();
        if (!inSpeech) {
          inSpeech = true;
          buf = [...pre]; // keep the start of the first word
        }
        speechFrames++;
        silentFrames = 0;
      } else if (inSpeech) silentFrames++;
      if (inSpeech) {
        buf.push(f);
        const secs = (buf.length * FRAME) / SR;
        if ((silentFrames * FRAME * 1000) / SR >= pauseMs || secs >= maxSecs) endPhrase();
      } else {
        pre.push(f);
        if (pre.length > 10) pre.shift(); // ~0.3 s of lead-in
      }
    }
    const s = useVoice.getState();
    const status: Status = inSpeech ? 'hearing' : 'listening';
    if (s.status !== status || Math.abs(s.level - peak) > 0.005) s.set({ status, level: Math.min(1, peak * 12) });
    if (idleStop > 0 && performance.now() - lastSpeech > idleStop * 1000) {
      stopVoice();
      toast('Voice typing stopped after a long silence.');
    }
  };
  window.addEventListener('focusin', onFocusIn);
  st.set({ status: 'listening' });
}

export function stopVoice() {
  proc?.disconnect();
  if (proc) proc.onaudioprocess = null;
  proc = null;
  ctx?.close().catch(() => {});
  ctx = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  window.removeEventListener('focusin', onFocusIn);
  const st = useVoice.getState();
  if (st.status !== 'error') st.set({ status: 'idle', level: 0 });
}

export function toggleVoice() {
  const st = useVoice.getState();
  if (st.status === 'listening' || st.status === 'hearing') stopVoice();
  else startVoice();
}

export function closeVoice() {
  stopVoice();
  useVoice.getState().set({ open: false, status: 'idle', error: '' });
  // Free the model's memory a while after closing.
  setTimeout(() => {
    if (!useVoice.getState().open) {
      worker?.terminate();
      worker = null;
      workerReady = null;
    }
  }, 120000);
}

// ---------- Panel ----------
export function VoiceTypingPanel() {
  const v = useVoice();
  const modelKey = useSettings((s) => (s.values['voice.model'] as string) || 'base');
  const m = v.models.find((x) => x.id === modelKey);
  useEffect(() => {
    if (!v.open) return;
    refreshVoiceModels();
    return api.speech.onDownload((x) => {
      useVoice.getState().set({ models: useVoice.getState().models.map((y) => (y.id === x.id ? x : y)) });
      if (x.installed && x.id === modelId() && !x.download) startVoice();
    });
  }, [v.open]);
  useEffect(() => {
    if (!v.open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (v.status === 'listening' || v.status === 'hearing') && stopVoice();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [v.open, v.status]);
  if (!v.open) return null;
  const live = v.status === 'listening' || v.status === 'hearing';
  const dl = m?.download;

  return (
    <div className="voice-panel" onMouseDown={(e) => (e.target as HTMLElement).tagName !== 'SELECT' && e.preventDefault()}>
      {m && !m.installed ? (
        <div className="voice-setup">
          <div className="voice-title">Voice typing runs on your computer</div>
          <div className="muted">
            It needs a one-time download of the speech model: <b>{m.label}</b> ({formatBytes(m.size)}). {m.blurb}
          </div>
          {dl && dl.status !== 'error' ? (
            <div className="voice-dl">
              <div className="voice-bar">
                <span style={{ width: `${Math.round((dl.received / dl.total) * 100)}%` }} />
              </div>
              <span className="muted">
                {formatBytes(dl.received)} of {formatBytes(dl.total)}
              </span>
              {dl.status === 'downloading' ? (
                <button className="icon-btn sm" title="Pause" onClick={() => api.speech.pause(m.id)}>
                  <Pause size={14} />
                </button>
              ) : (
                <button className="btn sm" onClick={() => api.speech.download(m.id)}>
                  Resume
                </button>
              )}
            </div>
          ) : (
            <div className="voice-row">
              <button className="btn sm primary" onClick={() => api.speech.download(m.id)}>
                <Download size={14} /> Download ({formatBytes(m.size)})
              </button>
              <button className="btn sm" onClick={() => openSettings('voice')}>
                Choose another
              </button>
              {dl?.error && <span className="drive-err">{dl.error}</span>}
            </div>
          )}
        </div>
      ) : (
        <div className="voice-row">
          <button
            className={`voice-mic ${live ? 'on' : ''} ${v.status === 'hearing' ? 'hearing' : ''}`}
            style={{ ['--lvl' as any]: v.level }}
            title={live ? 'Stop (Esc)' : 'Start talking'}
            onClick={toggleVoice}
            disabled={v.status === 'loading'}
          >
            {v.status === 'loading' ? <Loader2 size={20} className="spin" /> : live ? <Mic size={20} /> : <MicOff size={20} />}
          </button>
          <div className="voice-status">
            <div className="voice-title">
              {v.status === 'loading'
                ? `Starting voice typing… ${v.loadProgress ? Math.round(v.loadProgress) + '%' : ''}`
                : v.status === 'hearing'
                  ? 'Hearing you…'
                  : v.status === 'listening'
                    ? 'Listening. Start talking.'
                    : v.status === 'error'
                      ? 'Voice typing couldn’t start'
                      : 'Voice typing is paused'}
            </div>
            <div className="muted">
              {v.status === 'error'
                ? v.error
                : v.busy
                  ? `Typing what you said${v.busy > 1 ? ` (${v.busy} phrases)` : ''}…`
                  : live
                    ? 'Pause briefly and your words appear. Say "new line" or "new paragraph".'
                    : 'Click the microphone to continue.'}
            </div>
          </div>
        </div>
      )}
      <div className="voice-actions">
        <button className="icon-btn sm" title="Voice typing settings" onClick={() => openSettings('voice')}>
          <Settings2 size={15} />
        </button>
        <button className="icon-btn sm" title="Close voice typing" onClick={closeVoice}>
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

/** Settings → Voice typing: models (download / delete) and which microphone to use. */
export function VoiceSettingsExtras() {
  const models = useVoice((s) => s.models);
  const sel = useSettings((s) => (s.values['voice.model'] as string) || 'base');
  const mic = useSettings((s) => (s.values['voice.mic'] as string) || '');
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    refreshVoiceModels();
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => setMics(d.filter((x) => x.kind === 'audioinput' && x.deviceId !== 'default' && x.deviceId !== 'communications')))
      .catch(() => {});
    return api.speech.onDownload((x) => useVoice.getState().set({ models: useVoice.getState().models.map((y) => (y.id === x.id ? x : y)) }));
  }, []);
  return (
    <div className="voice-models">
      <div className="srow">
        <div className="srow-text">
          <div className="srow-label">Microphone</div>
        </div>
        <div className="srow-ctl">
          <select className="select" value={mic} onChange={(e) => useSettings.getState().set({ 'voice.mic': e.target.value })}>
            <option value="">Windows default</option>
            {mics.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="sgroup-title" style={{ marginTop: 14 }}>
        Speech models
      </div>
      {models.map((m) => (
        <div key={m.id} className={`voice-model ${sel === m.id ? 'on' : ''}`}>
          <label>
            <input type="radio" name="voice-model" checked={sel === m.id} onChange={() => useSettings.getState().set({ 'voice.model': m.id })} />
            <span>
              <b>{m.label}</b> · {formatBytes(m.size)}
              <div className="muted">{m.blurb}</div>
            </span>
          </label>
          {m.installed ? (
            <button className="btn sm" onClick={() => api.speech.remove(m.id).then(refreshVoiceModels)}>
              Delete
            </button>
          ) : m.download && m.download.status === 'downloading' ? (
            <span className="muted">{Math.round((m.download.received / m.download.total) * 100)}%</span>
          ) : (
            <button className="btn sm" onClick={() => api.speech.download(m.id)}>
              <Download size={13} /> {m.download ? 'Resume' : 'Download'}
            </button>
          )}
        </div>
      ))}
      <p className="muted" style={{ fontSize: 12 }}>
        Speech recognition uses OpenAI Whisper (MIT licence) and runs on this PC. Your voice is never uploaded.
      </p>
    </div>
  );
}

/** Test hook: turn audio (16 kHz mono) into text and type it, without a microphone. */
(window as any).__slateVoice = {
  async transcribe(audio: Float32Array): Promise<string> {
    const models = await refreshVoiceModels();
    const m = models.find((x) => x.id === modelId());
    if (!m?.installed) throw new Error('model not installed');
    await getWorker(m.repo);
    return new Promise((resolve) => {
      // Negative ids keep test requests out of the spoken-order queue.
      const id = -1 - Math.floor(Math.random() * 1e9);
      pending.set(id, resolve);
      worker!.postMessage({ type: 'transcribe', id, audio, englishOnly: m.englishOnly, language: 'auto' }, [audio.buffer]);
    });
  },
  type(text: string, seconds = 5) {
    const el = document.activeElement;
    if (isEditable(el)) target = el;
    insertText(text, seconds);
  }
};

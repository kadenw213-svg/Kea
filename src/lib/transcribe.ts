// Transcribe arbitrary audio into a timed transcript, on-device, reusing Kea's bundled Whisper worker
// (src/lib/speechWorker.ts). Separate from voice typing (which owns its own worker for the mic); this one is for
// indexing a clip. Input is 16 kHz mono Float32 (see to16kMono). No model installed → a clear, catchable error.
import { api } from './api';
import { setting } from './settings';

export interface TranscriptSegment {
  text: string;
  start: number;
  end: number;
}
export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
  /** Every word with its time, when the model can time words (the "+ word timing" models). */
  words?: TranscriptSegment[];
  model: string;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./speechWorker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (e: MessageEvent) => {
    const m = e.data;
    if (m.type === 'result' || m.type === 'error') {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        m.type === 'error' ? p.reject(new Error(m.message || 'Transcription failed.')) : p.resolve(m);
      }
    }
  });
  return worker;
}

let loadedRepo = '';
let loading: Promise<void> | null = null;
function loadModel(repo: string): Promise<void> {
  const w = getWorker();
  if (loadedRepo === repo && loading) return loading;
  loadedRepo = repo;
  loading = new Promise<void>((resolve, reject) => {
    const on = (e: MessageEvent) => {
      if (e.data.type === 'loaded') {
        w.removeEventListener('message', on);
        resolve();
      } else if (e.data.type === 'error' && e.data.id === undefined) {
        w.removeEventListener('message', on);
        reject(new Error(e.data.message || 'Couldn’t load the speech model.'));
      }
    };
    w.addEventListener('message', on);
    w.postMessage({ type: 'load', repo });
  });
  loading.catch(() => {
    loadedRepo = '';
    loading = null;
  });
  return loading;
}

/**
 * The installed Whisper model to use: for word timing, a "+ word timing" model if one is installed (best first);
 * otherwise the one picked in Settings, else base.en, else the first installed.
 */
async function pickModel(wantWords: boolean): Promise<{ repo: string; englishOnly: boolean; words: boolean }> {
  const installed = (await api.speech.state()).filter((m) => m.installed);
  if (!installed.length) throw new Error('No speech model is installed. Open Settings → Voice typing and download one (Whisper base.en is a good default; a "+ word timing" model gives exact word times in the video editor), then try again.');
  const want = setting('voice.model');
  const wordy = wantWords ? installed.find((x) => x.id === 'base-words') || installed.find((x) => x.words) : undefined;
  const m = wordy || installed.find((x) => x.id === want) || installed.find((x) => x.id === 'base') || installed[0];
  return { repo: m.repo, englishOnly: m.englishOnly, words: !!m.words };
}

/** Phrases from timed words: break after . ? ! or a pause over 0.6 s, at most 14 words. */
function phrases(words: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let cur: TranscriptSegment[] = [];
  const flush = () => {
    if (cur.length) out.push({ text: cur.map((w) => w.text).join(' '), start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    if (/[.?!]["”’)]*$/.test(w.text) || (next && next.start - w.end > 0.6) || cur.length >= 14) flush();
  });
  flush();
  return out;
}

const toSegs = (chunks: any[] | null | undefined): TranscriptSegment[] =>
  (chunks || []).map((c) => ({ text: String(c.text || '').trim(), start: c.timestamp?.[0] ?? 0, end: c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0 })).filter((x) => x.text);

// The native engine runs Whisper ~3x faster than the in-window worker; if it can't run at all, use the worker.
let engineBroken = false;

/** Transcribe 16 kHz mono audio. `audio` is transferred (don't reuse it after). */
export async function transcribe(audio: Float32Array, opts: { timestamps?: boolean | 'word' } = {}, signal?: AbortSignal): Promise<Transcript> {
  const wantWords = opts.timestamps === 'word';
  const { repo, englishOnly, words: canWords } = await pickModel(wantWords);
  const ts = wantWords && !canWords ? true : opts.timestamps ?? true;
  const finish = (text: string, chunks: any[] | null, gotWords: boolean): Transcript => {
    const segs = toSegs(chunks);
    return gotWords ? { text: text.trim(), segments: phrases(segs), words: segs, model: repo } : { text: text.trim(), segments: segs, model: repo };
  };
  if (api.engine && !engineBroken && String(setting('ai.accel') || 'auto') !== 'window') {
    try {
      const r: any = await api.engine.transcribe(repo, audio.slice().buffer, englishOnly, ts);
      if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
      return finish(r.text, r.chunks, ts === 'word' && r.words !== false);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      console.warn('Kea engine transcription unavailable, using the in-window model:', e);
      engineBroken = true;
    }
  }
  const w = getWorker();
  await loadModel(repo);
  if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
  const id = nextId++;
  const result = await new Promise<any>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    signal?.addEventListener(
      'abort',
      () => {
        if (pending.delete(id)) reject(new DOMException('Canceled', 'AbortError'));
      },
      { once: true }
    );
    w.postMessage({ type: 'transcribe', id, audio, englishOnly, timestamps: ts }, [audio.buffer]);
  });
  return finish(String(result.text || ''), result.chunks, ts === 'word' && result.words !== false);
}

/** Render an AudioBuffer (any rate/channels) down to 16 kHz mono Float32, as Whisper expects. */
export async function to16kMono(buffer: AudioBuffer): Promise<Float32Array> {
  const length = Math.max(1, Math.ceil(buffer.duration * 16000));
  const off = new OfflineAudioContext(1, length, 16000);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0).slice();
}

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

/** The installed Whisper model to use (the one picked in Settings, else base.en, else the first installed). */
async function pickModel(): Promise<{ repo: string; englishOnly: boolean }> {
  const installed = (await api.speech.state()).filter((m) => m.installed);
  if (!installed.length) throw new Error('No speech model is installed. Open Settings → Voice typing and download one (Whisper base.en is a good default), then try again.');
  const want = setting('voice.model');
  const m = installed.find((x) => x.id === want) || installed.find((x) => x.id === 'base') || installed[0];
  return { repo: m.repo, englishOnly: m.englishOnly };
}

/** Transcribe 16 kHz mono audio. `audio` is transferred (don't reuse it after). */
export async function transcribe(audio: Float32Array, opts: { timestamps?: boolean | 'word' } = {}, signal?: AbortSignal): Promise<Transcript> {
  const { repo, englishOnly } = await pickModel();
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
    w.postMessage({ type: 'transcribe', id, audio, englishOnly, timestamps: opts.timestamps ?? true }, [audio.buffer]);
  });
  const segments: TranscriptSegment[] = ((result.chunks as any[]) || [])
    .map((c) => ({ text: String(c.text || '').trim(), start: c.timestamp?.[0] ?? 0, end: c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0 }))
    .filter((s) => s.text);
  return { text: String(result.text || '').trim(), segments, model: repo };
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

// Drive the on-device segmentation worker (src/lib/segmentWorker.ts) to get a subject matte for an image. Mirrors
// src/lib/transcribe.ts. Used by the image editor's Remove background / Select subject. No model installed → a clear,
// catchable error pointing to Settings.
import { api } from './api';
import { setting } from './settings';

export interface Matte {
  /** One byte per pixel, 255 = foreground (keep), 0 = background. */
  alpha: Uint8Array;
  width: number;
  height: number;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./segmentWorker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (e: MessageEvent) => {
    const m = e.data;
    if (m.type === 'result' || m.type === 'error') {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        m.type === 'error' ? p.reject(new Error(m.message || 'Background removal failed.')) : p.resolve(m);
      }
    }
  });
  return worker;
}

let loadedRepo = '';
let loading: Promise<void> | null = null;
function loadModel(repo: string, dtype: string): Promise<void> {
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
        reject(new Error(e.data.message || 'Couldn’t load the model.'));
      }
    };
    w.addEventListener('message', on);
    w.postMessage({ type: 'load', repo, dtype });
  });
  loading.catch(() => {
    loadedRepo = '';
    loading = null;
  });
  return loading;
}

/** The installed segmentation model to use (chosen in Settings, else the default, else the first installed). */
async function pickModel(): Promise<{ id: string; repo: string; dtype: string }> {
  const installed = (await api.models.state('segmentation')).filter((m) => m.installed);
  if (!installed.length) throw new Error('No background-removal model is installed. Open Settings → AI image tools and download one (MODNet is a small, fast default), then try again.');
  const want = setting('ai.segmentModel');
  const m = installed.find((x) => x.id === want) || installed.find((x) => x.default) || installed[0];
  return { id: m.id, repo: m.repo, dtype: m.dtype };
}

// The native Kea engine (GPU via DirectML, else native CPU) is ~3-10x faster than the in-window worker. If it can't
// run at all (no engine in this build, binaries missing), stop trying for this session and use the worker.
let engineBroken = false;
const accel = () => String(setting('ai.accel') || 'auto');

/** Run background removal on RGBA pixels and return a foreground matte at the same size. */
export async function segment(img: { data: Uint8ClampedArray; width: number; height: number }, signal?: AbortSignal): Promise<Matte> {
  const { id: modelId, repo, dtype } = await pickModel();
  if (api.engine && !engineBroken && accel() !== 'window') {
    try {
      const buf = new Uint8Array(img.data).buffer; // copy; the original stays usable
      const r = await api.engine.segment('segmentation', modelId, buf, img.width, img.height, accel());
      if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
      return { alpha: r.alpha, width: r.width, height: r.height };
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      console.warn('Kea engine unavailable, using the in-window model:', e);
      engineBroken = true;
    }
  }
  const w = getWorker();
  await loadModel(repo, dtype);
  if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
  const id = nextId++;
  const data = new Uint8ClampedArray(img.data); // copy (the original stays usable); transferred to the worker
  const r = await new Promise<any>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    signal?.addEventListener('abort', () => pending.delete(id) && reject(new DOMException('Canceled', 'AbortError')), { once: true });
    w.postMessage({ type: 'segment', id, data, width: img.width, height: img.height }, [data.buffer]);
  });
  return { alpha: r.alpha, width: r.width, height: r.height };
}

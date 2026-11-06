import type { Adjustment, Filter } from './types';
import type { PixelJob } from './pixels.worker';
import { applyFilter, mixBySelection } from './filters';
import { applyAdjustment } from './adjustments';

/**
 * Client for the pixel worker. Falls back to running on this thread if the worker
 * can't start. A newer job with the same `key` cancels the older one's result (used by live previews).
 */

let worker: Worker | null = null;
let failed = false;
let seq = 0;
const pending = new Map<number, { resolve(b: ArrayBuffer): void; reject(e: Error): void }>();
const latest = new Map<string, number>();

function getWorker(): Worker | null {
  if (worker || failed) return worker;
  try {
    worker = new Worker(new URL('./pixels.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.buf);
    };
    worker.onerror = () => {
      // Worker crashed or couldn't load: fail what's waiting and run on this thread from now on.
      failed = true;
      worker?.terminate();
      worker = null;
      for (const p of pending.values()) p.reject(new Error('Image worker stopped'));
      pending.clear();
    };
  } catch {
    failed = true;
    worker = null;
  }
  return worker;
}

export class Superseded extends Error {}

/** Run a filter or adjustment over `img` (optionally limited to `sel`, one weight per pixel). */
export async function runPixels(
  op: 'filter' | 'adjust',
  img: ImageData,
  params: Filter | Adjustment,
  opts: { sel?: Uint8Array | null; place?: { x: number; y: number; w: number; h: number }; key?: string } = {}
): Promise<ImageData> {
  const id = ++seq;
  if (opts.key) latest.set(opts.key, id);
  const w = img.width,
    h = img.height;
  const wk = getWorker();
  let out: Uint8ClampedArray;
  if (wk) {
    const buf = img.data.slice().buffer;
    const sel = opts.sel ? opts.sel.slice().buffer : undefined;
    const job: PixelJob = { id, op, w, h, buf, params: JSON.parse(JSON.stringify(params)), sel, place: opts.place };
    const res = await new Promise<ArrayBuffer>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      wk.postMessage(job, sel ? [buf, sel] : [buf]);
    });
    out = new Uint8ClampedArray(res);
  } else {
    // Let the UI paint (spinner) before blocking.
    await new Promise((r) => setTimeout(r, 16));
    const src = img.data;
    if (op === 'filter') out = applyFilter(src, w, h, params as Filter, opts.place);
    else {
      out = new Uint8ClampedArray(src);
      applyAdjustment(out, params as Adjustment);
    }
    if (opts.sel) mixBySelection(src, out, opts.sel);
  }
  if (opts.key && latest.get(opts.key) !== id) throw new Superseded('superseded');
  return new ImageData(out as Uint8ClampedArray<ArrayBuffer>, w, h);
}

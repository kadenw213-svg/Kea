/// <reference lib="webworker" />
/**
 * Runs filters and destructive adjustments off the UI thread. Messages carry raw RGBA
 * buffers (transferred, not copied) and an optional selection weight per pixel.
 */
import { applyFilter, mixBySelection } from './filters';
import { applyAdjustment } from './adjustments';
import type { Adjustment, Filter } from './types';

export interface PixelJob {
  id: number;
  op: 'filter' | 'adjust';
  w: number;
  h: number;
  buf: ArrayBuffer;
  params: Filter | Adjustment;
  sel?: ArrayBuffer;
  place?: { x: number; y: number; w: number; h: number };
}

self.onmessage = (e: MessageEvent<PixelJob>) => {
  const j = e.data;
  try {
    const src = new Uint8ClampedArray(j.buf);
    let out: Uint8ClampedArray;
    if (j.op === 'filter') out = applyFilter(src, j.w, j.h, j.params as Filter, j.place);
    else {
      out = new Uint8ClampedArray(src);
      applyAdjustment(out, j.params as Adjustment);
    }
    if (j.sel) mixBySelection(src, out, new Uint8Array(j.sel));
    (self as unknown as Worker).postMessage({ id: j.id, buf: out.buffer }, [out.buffer]);
  } catch (err: any) {
    (self as unknown as Worker).postMessage({ id: j.id, error: String(err?.message || err) });
  }
};

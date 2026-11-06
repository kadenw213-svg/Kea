/// <reference lib="webworker" />
/**
 * On-device background removal / subject matting: a transformers.js segmentation model running in this worker with
 * ONNX Runtime (WebAssembly). Model files come from the user's data folder (app://kea/__aimodels/segmentation/…) and
 * the runtime from the app itself, so nothing is fetched from the internet. Cloned from speechWorker.ts.
 */
import { pipeline, env, RawImage } from '@huggingface/transformers';
import ortWasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import ortMjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('/__aimodels/segmentation/', self.location.href).href;
env.useBrowserCache = false;
env.useWasmCache = false;
const onnx = env.backends.onnx as any;
onnx.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href, mjs: new URL(ortMjsUrl, self.location.href).href };
onnx.wasm.numThreads = (self as any).crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2)) : 1;

let segmenter: any = null;
let loadedRepo = '';

type In = { type: 'load'; repo: string; dtype?: string } | { type: 'segment'; id: number; data: Uint8ClampedArray; width: number; height: number };

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      if (segmenter && loadedRepo === m.repo) return post({ type: 'loaded' });
      if (segmenter) await segmenter.dispose?.();
      segmenter = null;
      const files = new Map<string, number>();
      segmenter = await pipeline('background-removal', m.repo, {
        dtype: (m.dtype as any) || 'q8',
        device: 'wasm',
        session_options: { graphOptimizationLevel: 'basic' },
        progress_callback: (p: any) => {
          if (p.status === 'progress' && p.total) {
            files.set(p.file, p.progress);
            const avg = [...files.values()].reduce((a, b) => a + b, 0) / files.size;
            post({ type: 'progress', progress: avg });
          }
        }
      } as any);
      loadedRepo = m.repo;
      post({ type: 'loaded' });
    } else if (m.type === 'segment') {
      if (!segmenter) throw new Error('The background-removal model isn’t loaded yet.');
      const image = new RawImage(m.data, m.width, m.height, 4);
      const out = await segmenter(image);
      // The pipeline returns the image with the background made transparent; its alpha channel is the matte.
      const result: RawImage = Array.isArray(out) ? out[0] : out;
      const rgba = result.data as Uint8Array;
      const n = result.width * result.height;
      const alpha = new Uint8Array(n);
      const ch = result.channels || 4;
      for (let i = 0; i < n; i++) alpha[i] = ch >= 4 ? rgba[i * ch + 3] : rgba[i * ch]; // RGBA alpha, or a 1-channel matte
      post({ type: 'result', id: m.id, width: result.width, height: result.height, alpha }, [alpha.buffer]);
    }
  } catch (err: any) {
    post({ type: 'error', id: (m as any).id, message: err?.message || String(err) });
  }
};

function post(msg: any, transfer?: Transferable[]) {
  (self as any).postMessage(msg, transfer || []);
}

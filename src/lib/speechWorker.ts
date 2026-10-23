/// <reference lib="webworker" />
/**
 * Voice typing engine: OpenAI Whisper running in this worker with transformers.js + ONNX Runtime (WebAssembly).
 * The model files come from the user's data folder (app://kea/__speech/…) and the runtime from the app itself,
 * so nothing is fetched from the internet.
 */
import { pipeline, env } from '@huggingface/transformers';
import ortWasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import ortMjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('/__speech/', self.location.href).href;
env.useBrowserCache = false;
env.useWasmCache = false;
const onnx = env.backends.onnx as any;
// The runtime's WebAssembly ships inside the app (Vite emits it); without this it would come from a CDN.
onnx.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href, mjs: new URL(ortMjsUrl, self.location.href).href };
// Threads need cross-origin isolation; without it ONNX Runtime runs on one thread.
onnx.wasm.numThreads = (self as any).crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2)) : 1;

let asr: any = null;
let loadedRepo = '';

type In = { type: 'load'; repo: string } | { type: 'transcribe'; id: number; audio: Float32Array; language?: string; englishOnly: boolean; timestamps?: boolean | 'word' };

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      if (asr && loadedRepo === m.repo) return post({ type: 'loaded' });
      if (asr) await asr.dispose?.();
      asr = null;
      const files = new Map<string, number>();
      asr = await pipeline('automatic-speech-recognition', m.repo, {
        dtype: 'q8',
        device: 'wasm',
        // The newest ONNX Runtime optimizer trips over these int8 decoders; the basic level is fine and fast.
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
    } else if (m.type === 'transcribe') {
      if (!asr) throw new Error('Voice typing is not ready yet.');
      const t0 = performance.now();
      const opts: any = { chunk_length_s: 30, stride_length_s: 5 };
      if (m.timestamps) opts.return_timestamps = m.timestamps; // true = segment ranges, 'word' = per word
      if (!m.englishOnly) {
        opts.task = 'transcribe';
        if (m.language && m.language !== 'auto') opts.language = m.language;
      }
      let out: any;
      try {
        out = await asr(m.audio, opts);
      } catch (err) {
        // Word-level alignment isn't in every model (needs alignment_heads); fall back to segment ranges.
        if (opts.return_timestamps === 'word') {
          opts.return_timestamps = true;
          out = await asr(m.audio, opts);
        } else throw err;
      }
      post({ type: 'result', id: m.id, text: String(out?.text || ''), chunks: out?.chunks || null, words: opts.return_timestamps === 'word', ms: Math.round(performance.now() - t0) });
    }
  } catch (err: any) {
    post({ type: 'error', id: (m as any).id, message: err?.message || String(err) });
  }
};

function post(msg: any) {
  (self as any).postMessage(msg);
}

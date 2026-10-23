// Kea Engine worker: native on-device compute in its own utility process, so heavy work never blocks the window and
// a GPU driver crash can't take the app down (electron/engine.cjs restarts it on the CPU). Runs ONNX models with
// onnxruntime-node — on the graphics card through DirectML (any DX12 GPU: AMD, Intel, NVIDIA) where possible,
// otherwise native multi-threaded CPU. Measured on a Ryzen 7 7735U / Radeon 680M, MODNet at 512px: 798 ms/frame in
// the old in-window WASM path, 80 ms/frame here on DirectML.
//
// Protocol (process.parentPort): { id, op, ...args } -> { id, ok: true, ...result } | { id, ok: false, message }.
const ort = require('onnxruntime-node');

const sessions = new Map(); // `${file}|${ep}` -> InferenceSession
let queue = Promise.resolve(); // DirectML sessions are run one at a time

async function session(file, ep) {
  const key = `${file}|${ep}`;
  if (!sessions.has(key)) {
    const opts = { executionProviders: [ep], logSeverityLevel: 3, graphOptimizationLevel: 'all' };
    // DirectML wants these off; harmless on the CPU.
    if (ep === 'dml') Object.assign(opts, { enableMemPattern: false, executionMode: 'sequential' });
    sessions.set(key, ort.InferenceSession.create(file, opts));
  }
  try {
    return await sessions.get(key);
  } catch (e) {
    sessions.delete(key);
    throw e;
  }
}

/** Bilinear resize of interleaved RGBA into planar normalized float CHW. */
function toTensor(rgba, w, h, ow, oh, mean, std) {
  const out = new Float32Array(3 * ow * oh);
  const plane = ow * oh;
  const sx = w / ow;
  const sy = h / oh;
  for (let y = 0; y < oh; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < ow; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const wx = fx - x0;
      const i00 = (y0 * w + x0) * 4;
      const i01 = (y0 * w + x1) * 4;
      const i10 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      const o = y * ow + x;
      for (let c = 0; c < 3; c++) {
        const v = (rgba[i00 + c] * (1 - wx) + rgba[i01 + c] * wx) * (1 - wy) + (rgba[i10 + c] * (1 - wx) + rgba[i11 + c] * wx) * wy;
        out[c * plane + o] = (v / 255 - mean[c]) / std[c];
      }
    }
  }
  return out;
}

/** Bilinear resize of a single-channel float matte (0..1) to a byte alpha at the image size. */
function toAlpha(m, mw, mh, w, h) {
  const out = new Uint8Array(w * h);
  const sx = mw / w;
  const sy = mh / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(mh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(mh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(mw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(mw - 1, x0 + 1);
      const wx = fx - x0;
      const v = (m[y0 * mw + x0] * (1 - wx) + m[y0 * mw + x1] * wx) * (1 - wy) + (m[y1 * mw + x0] * (1 - wx) + m[y1 * mw + x1] * wx) * wy;
      out[y * w + x] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }
  return out;
}

// Input geometry and normalisation per model family (from each model's preprocessor_config.json).
const PREP = {
  modnet: (w, h) => {
    // shortest edge 512, both sides a multiple of 32
    const k = 512 / Math.min(w, h);
    const r32 = (v) => Math.max(32, Math.round(v / 32) * 32);
    return { ow: r32(w * k), oh: r32(h * k), mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] };
  },
  birefnet: () => ({ ow: 1024, oh: 1024, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] })
};

async function segment({ file, family, ep, rgba, width, height }) {
  const prep = (PREP[family] || PREP.modnet)(width, height);
  const s = await session(file, ep);
  const t0 = Date.now();
  const input = new ort.Tensor('float32', toTensor(new Uint8Array(rgba), width, height, prep.ow, prep.oh, prep.mean, prep.std), [1, 3, prep.oh, prep.ow]);
  const out = (await s.run({ [s.inputNames[0]]: input }))[s.outputNames[0]];
  let m = out.data;
  if (!(m instanceof Float32Array)) m = Float32Array.from(m);
  const mh = out.dims[out.dims.length - 2];
  const mw = out.dims[out.dims.length - 1];
  // Logit outputs (BiRefNet) need a sigmoid; matte outputs (MODNet) are already 0..1.
  if (m.some((v) => v < -1e-3 || v > 1.001)) {
    m = Float32Array.from(m);
    for (let i = 0; i < m.length; i++) m[i] = 1 / (1 + Math.exp(-m[i]));
  }
  const alpha = toAlpha(m, mw, mh, width, height);
  return { alpha: alpha.buffer, width, height, ms: Date.now() - t0 };
}

const OPS = {
  ping: async () => ({ version: ort.env?.versions?.common || '', eps: ort.listSupportedBackends ? ort.listSupportedBackends().map((b) => b.name) : [] }),
  segment
};

process.parentPort.on('message', (e) => {
  const msg = e.data || {};
  const run = OPS[msg.op];
  queue = queue.then(async () => {
    if (!run) return process.parentPort.postMessage({ id: msg.id, ok: false, message: `Unknown engine op: ${msg.op}` });
    try {
      const r = await run(msg);
      process.parentPort.postMessage({ id: msg.id, ok: true, ...r });
    } catch (err) {
      process.parentPort.postMessage({ id: msg.id, ok: false, message: String((err && err.message) || err) });
    }
  });
});

process.parentPort.postMessage({ type: 'ready' });

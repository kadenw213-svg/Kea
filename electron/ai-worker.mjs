// Slate AI worker: runs llama.cpp (via node-llama-cpp) in an Electron utility process so text
// generation never blocks the app window. Talks to the main process over parentPort messages.
import os from 'node:os';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';

const port = process.parentPort;
const send = (msg) => port.postMessage(msg);

let llama = null;
let llamaGpuSetting = null;
let model = null;
let modelKey = '';
let context = null;
let session = null;
const aborts = new Map();
let queue = Promise.resolve();
const stoppedEarly = new Set(); // stopped while still waiting in the queue

async function ensureLlama(gpu) {
  const want = gpu === false ? false : 'auto';
  if (llama && llamaGpuSetting === want) return llama;
  await unload();
  if (llama) await llama.dispose().catch(() => {});
  llama = await getLlama({ gpu: want, logLevel: 'error', progressLogs: false });
  llamaGpuSetting = want;
  return llama;
}

async function unload() {
  session?.dispose?.();
  session = null;
  if (context) await context.dispose().catch(() => {});
  context = null;
  if (model) await model.dispose().catch(() => {});
  model = null;
  modelKey = '';
}

async function hardware() {
  const l = await ensureLlama('auto');
  let vram = null;
  try {
    vram = await l.getVramState();
  } catch {}
  let gpuNames = [];
  try {
    gpuNames = await l.getGpuDeviceNames();
  } catch {}
  return {
    gpu: l.gpu || false,
    gpuNames,
    vramTotal: vram?.total || 0,
    vramFree: vram?.free || 0,
    unified: (vram?.unifiedSize || 0) > 0,
    ramTotal: os.totalmem(),
    ramFree: os.freemem(),
    cpuThreads: os.cpus().length,
    cpuName: os.cpus()[0]?.model?.trim() || ''
  };
}

async function load(opts) {
  const key = JSON.stringify([opts.modelPath, opts.gpu, opts.gpuLayers, opts.contextSize, opts.threads]);
  if (model && context && key === modelKey) return;
  const l = await ensureLlama(opts.gpu);
  await unload();
  const started = Date.now();
  model = await l.loadModel({
    modelPath: opts.modelPath,
    gpuLayers: opts.gpu === false ? 0 : opts.gpuLayers === 'auto' || opts.gpuLayers == null ? 'auto' : Number(opts.gpuLayers)
  });
  context = await model.createContext({
    contextSize: { min: 2048, max: opts.contextSize || 8192 },
    threads: opts.threads || undefined
  });
  session = new LlamaChatSession({ contextSequence: context.getSequence() });
  modelKey = key;
  send({ type: 'loaded', ms: Date.now() - started, contextSize: context.contextSize, gpu: l.gpu || false });
}

async function generate(msg) {
  const { id, history = [], prompt, system, maxTokens, temperature, jsonSchema } = msg;
  if (stoppedEarly.delete(id)) return send({ type: 'done', id, text: '', aborted: true });
  const ac = new AbortController();
  aborts.set(id, ac);
  let text = '';
  let tokens = 0;
  const started = Date.now();
  try {
    await load(msg.load);
    // Each request starts from a clean conversation built by the renderer.
    session.setChatHistory([
      ...(system ? [{ type: 'system', text: system }] : []),
      ...history.map((h) => (h.role === 'user' ? { type: 'user', text: h.text } : { type: 'model', response: [h.text] }))
    ]);
    const grammar = jsonSchema ? await llama.createGrammarForJsonSchema(jsonSchema) : undefined;
    await session.prompt(prompt, {
      maxTokens: maxTokens || 1024,
      temperature: temperature ?? 0.4,
      grammar,
      signal: ac.signal,
      stopOnAbortSignal: true,
      onToken(t) {
        tokens += t.length;
      },
      onTextChunk(chunk) {
        text += chunk;
        send({ type: 'token', id, text: chunk });
      }
    });
    const secs = Math.max(0.001, (Date.now() - started) / 1000);
    send({ type: 'done', id, text, tokensPerSecond: tokens / secs, aborted: ac.signal.aborted });
  } catch (err) {
    if (ac.signal.aborted) send({ type: 'done', id, text, aborted: true });
    else send({ type: 'error', id, message: String(err?.message || err) });
  } finally {
    aborts.delete(id);
  }
}

async function countTokens(msg) {
  try {
    await load(msg.load);
    send({ type: 'count', id: msg.id, count: model.tokenize(msg.text).length });
  } catch (err) {
    send({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
}

port.on('message', async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'hardware':
        send({ type: 'hardware', id: msg.id, info: await hardware() });
        break;
      case 'load':
        await load(msg.load);
        send({ type: 'ok', id: msg.id });
        break;
      case 'generate':
        // One model conversation at a time: queue requests so overlapping ones can't scramble each other.
        queue = queue.then(() => generate(msg));
        break;
      case 'count':
        countTokens(msg);
        break;
      case 'stop':
        if (aborts.has(msg.id)) aborts.get(msg.id).abort();
        else stoppedEarly.add(msg.id);
        break;
      case 'unload':
        await unload();
        send({ type: 'ok', id: msg.id });
        break;
    }
  } catch (err) {
    send({ type: 'error', id: msg.id, message: String(err?.message || err) });
  }
});

send({ type: 'ready' });

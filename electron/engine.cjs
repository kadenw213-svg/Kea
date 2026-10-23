// Kea Engine host (main process): starts electron/engine-worker.cjs in a utility process and forwards work to it.
// GPU first (DirectML), CPU if the GPU path fails. If the worker dies mid-GPU-job (a driver crash), that's remembered
// in <userData>/engine.json and the GPU is skipped until the user turns it back on in Settings; the job is retried on
// the CPU so the caller never sees the crash. Callers that can't use the engine at all fall back to the in-window path.
const { app, ipcMain, utilityProcess } = require('electron');
const fs = require('fs');
const path = require('path');
const models = require('./models.cjs');

let log = () => {};
let worker = null;
let ready = null;
let seq = 0;
const pending = new Map(); // id -> { resolve, reject, ep }
let lastEp = '';
let lastMs = 0;

const stateFile = () => path.join(app.getPath('userData'), 'engine.json');
function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}
function writeState(s) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(s));
  } catch {}
}

function start() {
  if (ready) return ready;
  worker = utilityProcess.fork(path.join(__dirname, 'engine-worker.cjs'), [], { serviceName: 'Kea Engine', stdio: 'pipe' });
  worker.stderr?.on('data', (d) => log('engine stderr', String(d).slice(0, 500)));
  ready = new Promise((resolve, reject) => {
    // A cold start (antivirus scanning the native DLLs, a slow disk) can be slow; if it never comes up, kill it so the
    // next call starts fresh instead of failing forever.
    const t = setTimeout(() => {
      reject(new Error('The Kea engine did not start.'));
      try {
        worker?.kill();
      } catch {}
      worker = null;
      ready = null;
    }, 60000);
    worker.on('message', (m) => {
      if (m?.type === 'ready') {
        clearTimeout(t);
        return resolve();
      }
      const p = m && pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      m.ok ? p.resolve(m) : p.reject(new Error(m.message || 'Engine error'));
    });
    worker.on('exit', (code) => {
      clearTimeout(t);
      log('engine exit', code);
      const gpuJob = [...pending.values()].some((p) => p.ep === 'dml');
      if (gpuJob && code !== 0) writeState({ ...readState(), gpuCrashed: true, crashedAt: Date.now() });
      worker = null;
      ready = null;
      for (const p of pending.values()) p.reject(Object.assign(new Error('The Kea engine stopped unexpectedly.'), { crashed: true, gpu: p.ep === 'dml' }));
      pending.clear();
      reject(new Error('The Kea engine stopped.'));
    });
  });
  ready.catch(() => {});
  return ready;
}

async function call(msg) {
  await start();
  const id = `e${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, ep: msg.ep });
    worker.postMessage({ ...msg, id });
  });
}

/** Execution providers to try for a request, best first. accel: 'auto' | 'gpu' | 'cpu'. */
function eps(accel) {
  if (accel === 'cpu' || process.platform !== 'win32') return ['cpu'];
  if (accel !== 'gpu' && readState().gpuCrashed) return ['cpu'];
  return ['dml', 'cpu'];
}

async function withFallback(accel, run) {
  let err;
  for (const ep of eps(accel)) {
    try {
      const r = await run(ep);
      lastEp = ep;
      return r;
    } catch (e) {
      err = e;
      log('engine', ep, 'failed:', e.message);
    }
  }
  throw err;
}

async function segment(type, id, rgba, width, height, accel) {
  const m = models.engineModel(type, id);
  if (!m) throw new Error('No background-removal model is installed.');
  return withFallback(accel, async (ep) => {
    const file = ep === 'dml' ? m.gpu || m.cpu : m.cpu || m.gpu;
    const r = await call({ op: 'segment', file, family: m.family, ep, rgba, width, height });
    lastMs = r.ms;
    return { alpha: new Uint8Array(r.alpha), width: r.width, height: r.height, ep, ms: r.ms };
  });
}

async function faces(id, rgba, width, height, accel) {
  const m = models.engineModel('faces', id);
  if (!m) throw new Error('No face finder is installed.');
  return withFallback(accel, (ep) => call({ op: 'faces', file: ep === 'dml' ? m.gpu : m.cpu, ep, rgba, width, height }).then((r) => ({ faces: r.faces, ep })));
}

/** Whisper on the native CPU (measured ~3x the in-window speed; the GPU doesn't help Whisper's step-by-step decoder). */
async function transcribe(repo, audio, englishOnly, timestamps) {
  const root = require('./speech.cjs').modelRoot();
  return call({ op: 'transcribe', root, repo, audio, englishOnly, timestamps });
}

function status() {
  const s = readState();
  return {
    available: process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin',
    running: !!worker,
    gpuSupported: process.platform === 'win32',
    gpuCrashed: !!s.gpuCrashed,
    lastDevice: lastEp === 'dml' ? 'gpu' : lastEp === 'cpu' ? 'cpu' : '',
    lastMs
  };
}

function register(opts) {
  log = (opts && opts.log) || log;
  ipcMain.handle('engine:status', () => status());
  ipcMain.handle('engine:resetGpu', () => {
    const s = readState();
    delete s.gpuCrashed;
    writeState(s);
    return status();
  });
  ipcMain.handle('engine:segment', (_e, type, id, rgba, width, height, accel) => segment(type, id, rgba, width, height, accel));
  ipcMain.handle('engine:faces', (_e, id, rgba, width, height, accel) => faces(id, rgba, width, height, accel));
  ipcMain.handle('engine:transcribe', async (_e, repo, audio, englishOnly, timestamps) => {
    const r = await transcribe(repo, audio, englishOnly, timestamps);
    return { text: r.text, chunks: r.chunks, ms: r.ms };
  });
  app.on('will-quit', () => {
    try {
      worker?.kill();
    } catch {}
  });
}

module.exports = { register, segment, transcribe, status };

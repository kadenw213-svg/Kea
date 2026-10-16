// Local AI: model catalog, downloads, settings and the llama.cpp worker process.
const { app, ipcMain, utilityProcess } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const GB = 1024 ** 3;

/** Curated models. Sizes/hashes come from the Hugging Face file listing. */
const CATALOG = {
  light: {
    tier: 'light',
    label: 'Light',
    model: 'Qwen 2.5 1.5B Instruct',
    license: 'Apache-2.0',
    file: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
    size: 986048768,
    sha256: '1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370',
    minRam: 6,
    blurb: 'Fastest. Good for short explanations and summaries.'
  },
  balanced: {
    tier: 'balanced',
    label: 'Balanced',
    model: 'Llama 3.2 3B Instruct',
    license: 'Llama 3.2 Community License',
    file: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    size: 2019377696,
    sha256: '6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff',
    minRam: 8,
    blurb: 'Quick and capable. Great default for writing help.'
  },
  best: {
    tier: 'best',
    label: 'Best',
    model: 'Qwen 2.5 7B Instruct',
    license: 'Apache-2.0',
    file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf',
    size: 4683074240,
    sha256: '65b8fcd92af6b4fefa935c625d1ac27ea29dcb6ee14589c55a8f115ceaaa1423',
    minRam: 16,
    blurb: 'Smartest feedback and grading. Slower on laptops without a strong GPU.'
  }
};

/** Speed ⟷ quality presets (slider positions 0–4). */
const PRESETS = [
  { tier: 'light', contextSize: 4096, maxTokens: 512 },
  { tier: 'balanced', contextSize: 4096, maxTokens: 768 },
  { tier: 'balanced', contextSize: 8192, maxTokens: 1024 },
  { tier: 'best', contextSize: 8192, maxTokens: 1024 },
  { tier: 'best', contextSize: 16384, maxTokens: 1536 }
];

const dir = () => path.join(app.getPath('userData'), 'models');
const settingsFile = () => path.join(app.getPath('userData'), 'ai-settings.json');
const modelPath = (tier) => path.join(dir(), CATALOG[tier].file);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let hardwareInfo = null;
let log = () => {};
let getWindow = () => null;

function recommend(hw) {
  const ram = (hw?.ramTotal || os.totalmem()) / GB;
  const dedicatedVram = hw && !hw.unified ? hw.vramTotal / GB : 0;
  let slider = 2; // balanced, 8k
  if (ram < 8) slider = 0;
  else if (ram < 12) slider = 1;
  else if (dedicatedVram >= 6 || (ram >= 32 && (hw?.cpuThreads || os.cpus().length) >= 16)) slider = 3;
  return { slider, ...PRESETS[slider] };
}

function defaultSettings() {
  const r = recommend(hardwareInfo);
  return {
    slider: r.slider,
    tier: r.tier,
    contextSize: r.contextSize,
    maxTokens: r.maxTokens,
    gpu: true,
    gpuLayers: 'auto',
    threads: 0,
    temperature: 0.4,
    keepLoaded: true,
    custom: false
  };
}

function getSettings() {
  return { ...defaultSettings(), ...readJson(settingsFile(), {}) };
}

// ---------- Worker ----------
let worker = null;
let workerReady = null;
let seq = 0;
const pending = new Map();
let idleTimer = null;

function startWorker() {
  if (worker) return workerReady;
  worker = utilityProcess.fork(path.join(__dirname, 'ai-worker.mjs'), [], { serviceName: 'Kea AI', stdio: 'pipe' });
  worker.stderr?.on('data', (d) => log('ai-worker stderr', String(d).slice(0, 500)));
  workerReady = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('The AI engine did not start.')), 30000);
    worker.once('message', (m) => {
      if (m?.type === 'ready') {
        clearTimeout(t);
        resolve();
      }
    });
  });
  worker.on('message', (m) => {
    if (!m || m.type === 'ready' || m.type === 'loaded') return;
    const p = pending.get(m.id);
    // Streamed generations go straight to the window; everything else resolves its caller.
    if (p?.stream || (!p && m.type === 'token')) {
      const win = getWindow();
      if (p && win && !win.isDestroyed()) win.webContents.send('ai:event', m);
      if (m.type !== 'token') {
        pending.delete(m.id);
        scheduleIdleUnload();
      }
      return;
    }
    if (!p || m.type === 'token') return;
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  });
  worker.on('exit', (code) => {
    log('ai-worker exit', code);
    worker = null;
    workerReady = null;
    for (const [id, p] of pending) {
      if (p.stream) {
        const win = getWindow();
        win?.webContents.send('ai:event', { type: 'error', id, message: 'The AI engine stopped unexpectedly. Try a smaller model or turn off GPU acceleration in AI settings.' });
      } else p.reject(new Error('The AI engine stopped unexpectedly.'));
    }
    pending.clear();
  });
  return workerReady;
}

async function call(msg, stream = false) {
  await startWorker();
  const id = msg.id || `r${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, stream });
    worker.postMessage({ ...msg, id });
    if (stream) resolve(id);
  });
}

function loadOptions() {
  const s = getSettings();
  return { modelPath: modelPath(s.tier), gpu: s.gpu, gpuLayers: s.gpuLayers, contextSize: s.contextSize, threads: s.threads || 0 };
}

function scheduleIdleUnload() {
  clearTimeout(idleTimer);
  if (getSettings().keepLoaded) return;
  idleTimer = setTimeout(() => worker && call({ type: 'unload' }).catch(() => {}), 5 * 60 * 1000);
}

async function hardware() {
  if (hardwareInfo) return hardwareInfo;
  try {
    const r = await call({ type: 'hardware' });
    hardwareInfo = r.info;
  } catch (err) {
    log('hardware detect failed', err);
    hardwareInfo = { gpu: false, gpuNames: [], vramTotal: 0, vramFree: 0, unified: false, ramTotal: os.totalmem(), ramFree: os.freemem(), cpuThreads: os.cpus().length, cpuName: os.cpus()[0]?.model || '' };
  }
  return hardwareInfo;
}

// ---------- Downloads ----------
const downloads = {}; // tier -> { status, received, total, error, controller }

function modelState(tier) {
  const c = CATALOG[tier];
  const installed = fs.existsSync(modelPath(tier)) && fs.statSync(modelPath(tier)).size === c.size;
  const d = downloads[tier];
  let partial = 0;
  try {
    partial = fs.statSync(modelPath(tier) + '.part').size;
  } catch {}
  return {
    tier,
    label: c.label,
    model: c.model,
    license: c.license,
    size: c.size,
    minRam: c.minRam,
    blurb: c.blurb,
    installed,
    download: d ? { status: d.status, received: d.received, total: d.total, error: d.error } : partial ? { status: 'paused', received: partial, total: c.size } : null
  };
}

function emitDownload(tier) {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('ai:download', modelState(tier));
}

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

async function download(tier) {
  const c = CATALOG[tier];
  if (!c) throw new Error('Unknown model');
  if (downloads[tier]?.status === 'downloading') return;
  fs.mkdirSync(dir(), { recursive: true });
  const part = modelPath(tier) + '.part';
  let start = 0;
  try {
    start = fs.statSync(part).size;
  } catch {}
  const controller = new AbortController();
  const d = (downloads[tier] = { status: 'downloading', received: start, total: c.size, controller });
  emitDownload(tier);
  try {
    const res = await fetch(c.url, { headers: start ? { Range: `bytes=${start}-` } : {}, signal: controller.signal, redirect: 'follow' });
    if (!res.ok && res.status !== 206) throw new Error(`Download failed (HTTP ${res.status})`);
    if (start && res.status !== 206) start = 0; // server ignored the range: start over
    const out = fs.createWriteStream(part, { flags: start ? 'a' : 'w' });
    d.received = start;
    let lastEmit = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      d.received += value.length;
      if (Date.now() - lastEmit > 250) {
        lastEmit = Date.now();
        emitDownload(tier);
      }
    }
    await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
    d.status = 'verifying';
    emitDownload(tier);
    const hash = await hashFile(part);
    if (hash !== c.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error('The download was corrupted. Please try again.');
    }
    fs.renameSync(part, modelPath(tier));
    d.status = 'done';
    emitDownload(tier);
    delete downloads[tier];
    emitDownload(tier);
  } catch (err) {
    if (controller.signal.aborted) {
      d.status = 'paused';
    } else {
      log('model download failed', tier, err);
      d.status = 'error';
      d.error = /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT/i.test(String(err?.message || err))
        ? "Couldn't reach the download server. Check your internet connection; the download will resume where it stopped."
        : String(err?.message || err);
    }
    emitDownload(tier);
  }
}

function register(opts) {
  log = opts.log;
  getWindow = opts.getWindow;

  ipcMain.handle('ai:state', async () => {
    const hw = await hardware();
    return {
      hardware: hw,
      settings: getSettings(),
      recommended: recommend(hw),
      presets: PRESETS,
      models: Object.keys(CATALOG).map(modelState)
    };
  });
  ipcMain.handle('ai:set-settings', async (_e, patch) => {
    const next = { ...getSettings(), ...patch };
    if (patch && patch.slider !== undefined && !patch.custom) Object.assign(next, PRESETS[patch.slider], { custom: false });
    writeJson(settingsFile(), next);
    if (!next.keepLoaded) scheduleIdleUnload();
    return next;
  });
  ipcMain.handle('ai:reset-settings', async () => {
    fs.rmSync(settingsFile(), { force: true });
    return getSettings();
  });
  ipcMain.handle('ai:download', (_e, tier) => {
    download(tier);
    return true;
  });
  ipcMain.handle('ai:pause-download', (_e, tier) => {
    downloads[tier]?.controller?.abort();
    return true;
  });
  ipcMain.handle('ai:delete-model', async (_e, tier) => {
    downloads[tier]?.controller?.abort();
    delete downloads[tier];
    if (worker) await call({ type: 'unload' }).catch(() => {});
    fs.rmSync(modelPath(tier), { force: true });
    fs.rmSync(modelPath(tier) + '.part', { force: true });
    emitDownload(tier);
    return true;
  });
  ipcMain.handle('ai:generate', async (_e, req) => {
    const s = getSettings();
    if (!modelState(s.tier).installed) throw new Error('NO_MODEL');
    clearTimeout(idleTimer);
    return call(
      {
        type: 'generate',
        load: loadOptions(),
        system: req.system,
        history: req.history || [],
        prompt: req.prompt,
        maxTokens: req.maxTokens || s.maxTokens,
        temperature: req.temperature ?? s.temperature,
        jsonSchema: req.jsonSchema
      },
      true
    );
  });
  ipcMain.handle('ai:stop', (_e, id) => {
    worker?.postMessage({ type: 'stop', id });
    return true;
  });
  ipcMain.handle('ai:count', async (_e, text) => {
    const r = await call({ type: 'count', load: loadOptions(), text });
    return r.count;
  });
  ipcMain.handle('ai:benchmark', async () => {
    const s = getSettings();
    if (!modelState(s.tier).installed) throw new Error('NO_MODEL');
    const started = Date.now();
    await call({ type: 'load', load: loadOptions() });
    const loadMs = Date.now() - started;
    const id = `b${++seq}`;
    const result = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, stream: false });
      worker.postMessage({
        type: 'generate',
        id,
        load: loadOptions(),
        prompt: 'Write a short paragraph (about 80 words) describing why autumn leaves change colour.',
        maxTokens: 128,
        temperature: 0.2
      });
    });
    return { loadMs, tokensPerSecond: result.tokensPerSecond || 0 };
  });
  app.on('before-quit', () => {
    try {
      worker?.kill();
    } catch {}
  });
}

module.exports = { register, CATALOG };

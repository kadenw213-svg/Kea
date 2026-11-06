// On-device AI models (beyond speech): downloaded once from a pinned Hugging Face revision, every file SHA-256
// checked, stored in <userData>/ai-models/<type>/<repo>/…, and served to the renderer from app://kea/__aimodels/…
// so inference runs entirely on this PC. Modelled on electron/speech.cjs; kept separate so voice/LLM stay untouched.
// Keyed by model TYPE ('segmentation' now) so it can hold more kinds later.
const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REGISTRY = {
  // Background removal / subject matting. Both licence-clean for a freely distributed app (RMBG is NOT — CC BY-NC).
  segmentation: {
    modnet: {
      repo: 'Xenova/modnet',
      rev: 'fa2fa546052fba4c08921230a26cc69a333fca12',
      label: 'Fast (MODNet)',
      blurb: 'Great for people and clear subjects. Small and quick.',
      license: 'Apache-2.0',
      task: 'background-removal',
      dtype: 'q8',
      default: true,
      // The Kea engine runs the fp16 file on both the graphics card (DirectML handles int8 badly) and the native CPU
      // (measured ~2x faster than int8 there); the in-window WASM fallback uses the int8 file.
      family: 'modnet',
      gpuFile: 'onnx/model_fp16.onnx',
      cpuFile: 'onnx/model_fp16.onnx',
      files: [
        { path: 'config.json', size: 83, sha256: 'e144d8af9b1f09649785c77f592a76bbc69504ae02e43700663b2a9f00d9c8a2' },
        { path: 'preprocessor_config.json', size: 365, sha256: '07d83634b1fdd20142ca6e3fe55ab92b558f56d1b0f005ff3a7926f1c9e1165d' },
        { path: 'onnx/model_quantized.onnx', size: 6632188, sha256: '92e49898c3e05a6d7a944fc67a8cb87c4aad754ffb6ebd949528c7d1105fee3a' },
        { path: 'onnx/model_fp16.onnx', size: 12984781, sha256: '25f165da9bfd30830a575f1f0490f1acd995975cb349bc02f3d79332e1fe5cf6' }
      ]
    },
    birefnet: {
      repo: 'onnx-community/BiRefNet-ONNX',
      rev: '534d3c82d3bb8b2f0867db6dfbc3a525b8e42f67',
      label: 'Best quality (BiRefNet)',
      blurb: 'Highest quality on any subject. Large download, slower.',
      license: 'MIT',
      task: 'background-removal',
      dtype: 'fp16',
      family: 'birefnet',
      gpuFile: 'onnx/model_fp16.onnx',
      cpuFile: 'onnx/model_fp16.onnx',
      files: [
        { path: 'config.json', size: 30, sha256: '88b20240c9078cf9cc3843dc7d69a42d274b8c242de56a3b2a41ef9995cb93bf' },
        { path: 'preprocessor_config.json', size: 391, sha256: '447d9ccb2c4129ab0ca045fc293e7d79dbc45e293ac1e94818d865db77f65a54' },
        { path: 'onnx/model_fp16.onnx', size: 489666272, sha256: '3654c741eb80bd926ada8fed1713b506ccf8d30eb1f6487e87eb9f234f33df09' }
      ]
    }
  },
  // Face detection, for face-tracked reframing (9:16 etc.) in the video editor. OpenCV's YuNet, MIT licence.
  faces: {
    yunet: {
      repo: 'opencv/face_detection_yunet',
      rev: '3cc26e7f1014a5ee5d74a42acee58bafc9d0a310',
      label: 'Face finder (YuNet)',
      blurb: 'Finds faces so Kea can keep the speaker in frame when reframing to vertical or square. Tiny and fast.',
      license: 'MIT',
      task: 'face-detection',
      dtype: 'fp32',
      default: true,
      family: 'yunet',
      gpuFile: 'face_detection_yunet_2023mar.onnx',
      cpuFile: 'face_detection_yunet_2023mar.onnx',
      files: [
        { path: 'face_detection_yunet_2023mar.onnx', size: 232589, sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4' },
        { path: 'LICENSE', size: 1085, sha256: 'c83b8120c50ccbd4c4f96edf53141bdd566ebb8f8e9227e415326aa1b1aba958' }
      ]
    }
  }
};

const typeRoot = (type) => path.join(app.getPath('userData'), 'ai-models', type);
const catalog = (type) => REGISTRY[type] || {};
const entry = (type, id) => catalog(type)[id];
const fileOf = (type, id, rel) => path.join(typeRoot(type), ...entry(type, id).repo.split('/'), ...rel.split('/'));
const totalOf = (type, id) => entry(type, id).files.reduce((a, f) => a + f.size, 0);

const downloads = {}; // `${type}:${id}` -> { status, received, total, error, controller }
let getWindow = () => null;
let log = () => {};

function sizeOn(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function modelState(type, id) {
  const c = entry(type, id);
  const installed = c.files.every((f) => sizeOn(fileOf(type, id, f.path)) === f.size);
  const d = downloads[`${type}:${id}`];
  const have = c.files.reduce((a, f) => a + Math.min(f.size, sizeOn(fileOf(type, id, f.path)) || sizeOn(fileOf(type, id, f.path) + '.part')), 0);
  return {
    type,
    id,
    repo: c.repo,
    label: c.label,
    blurb: c.blurb,
    license: c.license,
    task: c.task,
    dtype: c.dtype,
    default: !!c.default,
    size: totalOf(type, id),
    installed,
    download: d ? { status: d.status, received: d.received, total: d.total, error: d.error } : !installed && have ? { status: 'paused', received: have, total: totalOf(type, id) } : null
  };
}

function emit(type, id) {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('models:download', modelState(type, id));
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

async function download(type, id) {
  const c = entry(type, id);
  if (!c) throw new Error('Unknown model');
  const key = `${type}:${id}`;
  if (downloads[key]?.status === 'downloading') return;
  const controller = new AbortController();
  const d = (downloads[key] = { status: 'downloading', received: 0, total: totalOf(type, id), controller });
  emit(type, id);
  let out = null;
  try {
    let done = 0;
    for (const f of c.files) {
      const dest = fileOf(type, id, f.path);
      if (sizeOn(dest) === f.size) {
        done += f.size;
        d.received = done;
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const part = dest + '.part';
      let start = sizeOn(part);
      if (start > f.size) start = 0;
      // A .part that's already whole (Kea closed while it was being checked) only needs its check; asking the server
      // for bytes past the end would get HTTP 416.
      if (start < f.size) {
        const url = `https://huggingface.co/${c.repo}/resolve/${c.rev}/${f.path}`;
        const res = await fetch(url, { headers: start ? { Range: `bytes=${start}-` } : {}, signal: controller.signal, redirect: 'follow' });
        if (!res.ok && res.status !== 206) throw new Error(`Download failed (HTTP ${res.status})`);
        if (start && res.status !== 206) start = 0;
        out = fs.createWriteStream(part, { flags: start ? 'a' : 'w' });
        let got = start;
        let lastEmit = 0;
        const reader = res.body.getReader();
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          if (!out.write(value)) await new Promise((r) => out.once('drain', r));
          got += value.length;
          d.received = done + got;
          if (Date.now() - lastEmit > 250) {
            lastEmit = Date.now();
            emit(type, id);
          }
        }
        const w = out;
        await new Promise((r, j) => w.end((err) => (err ? j(err) : r())));
        out = null;
      }
      if ((await hashFile(part)) !== f.sha256) {
        fs.rmSync(part, { force: true });
        throw new Error('The download was corrupted. Please try again.');
      }
      fs.renameSync(part, dest);
      done += f.size;
      d.received = done;
    }
    delete downloads[key];
    emit(type, id);
  } catch (err) {
    // Close the .part file now: a stray handle would block deleting the model, and late buffered writes could land
    // after a resume has started appending. (Waits so a quick resume can't race it.)
    if (out && !out.closed)
      await new Promise((r) => {
        out.once('close', r);
        out.end();
      });
    if (controller.signal.aborted) d.status = 'paused';
    else {
      log('AI model download failed', type, id, err);
      d.status = 'error';
      d.error = /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT/i.test(String(err?.message || err))
        ? "Couldn't reach the download server. Check your internet connection; the download will resume where it stopped."
        : String(err?.message || err);
    }
    emit(type, id);
  }
}

/** Path on disk for app://kea/__aimodels/<type>/<repo>/<file>, or null if it isn't one of our model files. */
function resolveServed(rel) {
  const base = path.join(app.getPath('userData'), 'ai-models');
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base + path.sep) ? p : null;
}

/** On-disk files for the Kea engine (electron/engine.cjs), or null if the model isn't fully installed. */
function engineModel(type, id) {
  const c = entry(type, id);
  if (!c || !c.files.every((f) => sizeOn(fileOf(type, id, f.path)) === f.size)) return null;
  return { family: c.family, gpu: c.gpuFile ? fileOf(type, id, c.gpuFile) : null, cpu: c.cpuFile ? fileOf(type, id, c.cpuFile) : null };
}

function register(opts) {
  log = (opts && opts.log) || log;
  getWindow = (opts && opts.getWindow) || getWindow;
  ipcMain.handle('models:state', (_e, type) => Object.keys(catalog(type)).map((id) => modelState(type, id)));
  ipcMain.handle('models:download', (_e, type, id) => {
    download(type, id);
    return true;
  });
  ipcMain.handle('models:pause', (_e, type, id) => {
    downloads[`${type}:${id}`]?.controller?.abort();
    return true;
  });
  ipcMain.handle('models:delete', (_e, type, id) => {
    if (!entry(type, id)) return false;
    downloads[`${type}:${id}`]?.controller?.abort();
    delete downloads[`${type}:${id}`];
    fs.rmSync(path.join(typeRoot(type), ...entry(type, id).repo.split('/')), { recursive: true, force: true });
    emit(type, id);
    return true;
  });
}

module.exports = { register, resolveServed, engineModel };

// Voice typing: downloads OpenAI Whisper speech-recognition models (ONNX, MIT licence) once, from a pinned
// revision on Hugging Face, checks every file's SHA-256, and stores them in <userData>/speech. The renderer
// loads them from app://kea/__speech/… so recognition runs entirely on this PC.
const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CATALOG = {
  'tiny': {
    repo: 'onnx-community/whisper-tiny.en',
    rev: '2575352d61be1bf7225cf8f8b268a4678025fc58',
    label: 'Fastest',
    blurb: 'English only. Quick, good for clear speech.',
    englishOnly: true,
    files: [
      { path: 'config.json', size: 2197, sha256: '251ea843b5901a99efa58c0b99b8052c6019aa3e7d2baf46693a1128ff606233' },
      { path: 'generation_config.json', size: 1646, sha256: '7b2e8451ed5f118e75fdd991409d72119d21d2fef1eba9723f68fb9c57fe5dc9' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', size: 30718858, sha256: 'c0592d0749413c960569e1c7fb806b060d5d18f3ebad4a95cbf9a77dc6e9be52' },
      { path: 'onnx/encoder_model_quantized.onnx', size: 10124993, sha256: 'e93ec822f16a8fd264e7de972ad17d615ea7334b75a52d54c50c2e18dd503a25' },
      { path: 'preprocessor_config.json', size: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', size: 2405679, sha256: '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0' },
      { path: 'tokenizer_config.json', size: 282662, sha256: '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c' }
    ]
  },
  'base': {
    repo: 'onnx-community/whisper-base.en',
    rev: '51eefc0af78b103839eda9e7e4f4186acc6517fe',
    label: 'Balanced',
    blurb: 'English only. Accurate and quick on most PCs.',
    englishOnly: true,
    files: [
      { path: 'config.json', size: 2197, sha256: 'c8a0de5ed8a083565a4319db29d0c210fda35b4d6076c2d711cae53ae00f3cb1' },
      { path: 'generation_config.json', size: 1556, sha256: '3479b1f44a07e41db799e22599222fee5816738036def94a39841cb9cdbb4120' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', size: 53692803, sha256: 'dd4761a3f7add26afda3512abff4706920404c2517e85a9f2ff090b0c0987909' },
      { path: 'onnx/encoder_model_quantized.onnx', size: 23201320, sha256: '6e8001198c490bbae018c0044f630c2915efb826bad957006ce36152d0ab2a10' },
      { path: 'preprocessor_config.json', size: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', size: 2405679, sha256: '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0' },
      { path: 'tokenizer_config.json', size: 282662, sha256: '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c' }
    ]
  },
  'small': {
    repo: 'onnx-community/whisper-small.en',
    rev: '482fb8ba081b6e906f92efe103622316b2a0cc69',
    label: 'Most accurate',
    blurb: 'English only. Best results; slower on older PCs.',
    englishOnly: true,
    files: [
      { path: 'config.json', size: 2203, sha256: '8825c4174cb86f94d9fa67614942f8aa17bfbbdf2fae5426d4adfd0bc5893c43' },
      { path: 'generation_config.json', size: 1956, sha256: '5490747ca976d6b3765280a0697d66489020c2afa6e754244d9cd093e1639331' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', size: 156750076, sha256: '29132c41903c252d0f2b9e59ee1e7d75f7d0b64d37f3e36d1ecc4a1a1af62953' },
      { path: 'onnx/encoder_model_quantized.onnx', size: 92326170, sha256: 'dae677b93ca77f911d858238e277026fa8f95a94cb899ea443ec78ee62726edf' },
      { path: 'preprocessor_config.json', size: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', size: 2405679, sha256: '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0' },
      { path: 'tokenizer_config.json', size: 282662, sha256: '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c' }
    ]
  },
  'base-multi': {
    repo: 'onnx-community/whisper-base',
    rev: '1846881b6b3a3024392c1eea3ad983695bc23925',
    label: 'Balanced, many languages',
    blurb: 'About 100 languages. Accurate and quick.',
    englishOnly: false,
    files: [
      { path: 'config.json', size: 2243, sha256: 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b' },
      { path: 'generation_config.json', size: 3832, sha256: '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', size: 53693315, sha256: 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b' },
      { path: 'onnx/encoder_model_quantized.onnx', size: 23201314, sha256: '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46' },
      { path: 'preprocessor_config.json', size: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', size: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', size: 282682, sha256: '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573' }
    ]
  },
  'small-multi': {
    repo: 'onnx-community/whisper-small',
    rev: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
    label: 'Most accurate, many languages',
    blurb: 'About 100 languages. Best results; slower.',
    englishOnly: false,
    files: [
      { path: 'config.json', size: 2227, sha256: '457854d452f17661e197d74aee12b8e74fb75ba30ebfaa7426d0d61ea1e08a18' },
      { path: 'generation_config.json', size: 3893, sha256: 'f538b28220c6a6d6f1af1458d4141cacb4ef4963df3de98a19490440c412ddf0' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', size: 156750845, sha256: 'ec07c3cbb64172c39791e26ee870a65ac22b458c36722bfe2776b3dbf741e0c9' },
      { path: 'onnx/encoder_model_quantized.onnx', size: 92326160, sha256: 'a43a83f3c5361cd591cfa7c36f14b43cf7cb22f47a415cc14a8d557be800fa92' },
      { path: 'preprocessor_config.json', size: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', size: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
      { path: 'tokenizer_config.json', size: 282683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' }
    ]
  },
  'tiny-words': {
    repo: 'onnx-community/whisper-tiny.en_timestamped',
    rev: 'aeaa13760958b03fac5062f457d317d3319c3168',
    label: 'Fastest + word timing',
    blurb: 'English only. Times every word — for captions and cutting to a script in the video editor.',
    englishOnly: true,
    // Exported with cross-attentions, so Whisper can time every word (video editor: captions, script cuts).
    words: true,
    files: [
      { path: 'config.json', size: 2197, sha256: '251ea843b5901a99efa58c0b99b8052c6019aa3e7d2baf46693a1128ff606233' },
      { path: 'generation_config.json', size: 1646, sha256: '7b2e8451ed5f118e75fdd991409d72119d21d2fef1eba9723f68fb9c57fe5dc9' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', size: 30729881, sha256: 'f2df67fbe1cf39c9b050d05029b55e217a9467f3453ae5110e2bcc0f5ba73652' },
      { path: 'onnx/encoder_model_quantized.onnx', size: 10097112, sha256: '697eaa5668bb13343965f423d6002273479b8508f592bd26970735516ed5039e' },
      { path: 'preprocessor_config.json', size: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', size: 2405679, sha256: '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0' },
      { path: 'tokenizer_config.json', size: 282662, sha256: '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c' }
    ]
  },
  'base-words': {
    repo: 'onnx-community/whisper-base.en_timestamped',
    rev: 'fa239a41836c3305f6beec180e5940f3823ff5b8',
    label: 'Balanced + word timing',
    blurb: 'English only. More accurate, and times every word for captions and script cuts.',
    englishOnly: true,
    // Exported with cross-attentions, so Whisper can time every word (video editor: captions, script cuts).
    words: true,
    files: [
      { path: 'config.json', size: 2197, sha256: 'c8a0de5ed8a083565a4319db29d0c210fda35b4d6076c2d711cae53ae00f3cb1' },
      { path: 'generation_config.json', size: 1556, sha256: '3479b1f44a07e41db799e22599222fee5816738036def94a39841cb9cdbb4120' },
      { path: 'onnx/decoder_model_merged_quantized.onnx', size: 53712196, sha256: 'afa8065a5f023f6e524417f9459cc09969023dd38149cd4dce16628b2c3a1773' },
      { path: 'onnx/encoder_model_quantized.onnx', size: 23159173, sha256: '9b4d25507aef3d3a8d718695b8adcb0488e66aad8e884333c3fa73a1c3baa906' },
      { path: 'preprocessor_config.json', size: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
      { path: 'tokenizer.json', size: 2405679, sha256: '5eb60cec1e77aeeb6869a2bb5a8e01a84c3fe5d072d75369343021fe6f5310d0' },
      { path: 'tokenizer_config.json', size: 282662, sha256: '93879c3dccdd4b976f709acd85b44778873f30c275e67026f30ca1e4c975230c' }
    ]
  }
};

const root = () => path.join(app.getPath('userData'), 'speech');
const fileOf = (id, rel) => path.join(root(), ...CATALOG[id].repo.split('/'), ...rel.split('/'));
const totalOf = (id) => CATALOG[id].files.reduce((a, f) => a + f.size, 0);

const downloads = {}; // id -> { status, received, total, error, controller }
let getWindow = () => null;
let log = () => {};

function sizeOn(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function modelState(id) {
  const c = CATALOG[id];
  const installed = c.files.every((f) => sizeOn(fileOf(id, f.path)) === f.size);
  const d = downloads[id];
  const have = c.files.reduce((a, f) => a + Math.min(f.size, sizeOn(fileOf(id, f.path)) || sizeOn(fileOf(id, f.path) + '.part')), 0);
  return {
    id,
    repo: c.repo,
    label: c.label,
    blurb: c.blurb,
    englishOnly: c.englishOnly,
    words: !!c.words,
    size: totalOf(id),
    installed,
    download: d ? { status: d.status, received: d.received, total: d.total, error: d.error } : !installed && have ? { status: 'paused', received: have, total: totalOf(id) } : null
  };
}

function emit(id) {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('speech:download', modelState(id));
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

async function download(id) {
  const c = CATALOG[id];
  if (!c) throw new Error('Unknown speech model');
  if (downloads[id]?.status === 'downloading') return;
  const controller = new AbortController();
  const d = (downloads[id] = { status: 'downloading', received: 0, total: totalOf(id), controller });
  emit(id);
  let out = null;
  try {
    let done = 0;
    for (const f of c.files) {
      const dest = fileOf(id, f.path);
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
            emit(id);
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
    delete downloads[id];
    emit(id);
  } catch (err) {
    // Close the .part file before anything else can resume or delete it.
    if (out && !out.closed)
      await new Promise((r) => {
        out.once('close', r);
        out.end();
      });
    if (controller.signal.aborted) d.status = 'paused';
    else {
      log('speech model download failed', id, err);
      d.status = 'error';
      d.error = /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT/i.test(String(err?.message || err))
        ? "Couldn't reach the download server. Check your internet connection; the download will resume where it stopped."
        : String(err?.message || err);
    }
    emit(id);
  }
}

/** Path on disk for app://kea/__speech/<repo>/<file>, or null if it isn't one of our model files. */
function resolveServed(rel) {
  const base = root();
  const p = path.normalize(path.join(base, rel));
  return p.startsWith(base + path.sep) ? p : null;
}

function register(opts) {
  log = opts.log || log;
  getWindow = opts.getWindow || getWindow;
  ipcMain.handle('speech:state', () => Object.keys(CATALOG).map(modelState));
  ipcMain.handle('speech:download', (_e, id) => {
    download(id);
    return true;
  });
  ipcMain.handle('speech:pause', (_e, id) => {
    downloads[id]?.controller?.abort();
    return true;
  });
  ipcMain.handle('speech:delete', (_e, id) => {
    if (!CATALOG[id]) return false;
    downloads[id]?.controller?.abort();
    delete downloads[id];
    fs.rmSync(path.join(root(), ...CATALOG[id].repo.split('/')), { recursive: true, force: true });
    emit(id);
    return true;
  });
}

/** Folder the engine loads Whisper models from (transformers.js localModelPath). */
const modelRoot = () => root();

module.exports = { modelRoot, register, resolveServed };

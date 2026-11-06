// Read aloud with the voices installed in Windows (System.Speech / SAPI, fully offline).
// One speech process stays running while reading, so paragraphs follow each other without a pause.
// Stopping kills it (a new one starts on the next request).
const { ipcMain } = require('electron');
const { execFile, spawn } = require('child_process');

const SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '[Console]::Out.WriteLine("READY")',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($line -eq $null) { break }',
  '  $p = $line.Split("|")',
  '  if ($p[1]) { try { $s.SelectVoice([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))) } catch {} }',
  '  $s.Rate = [int]$p[2]',
  '  try { $s.Speak([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[0]))) } catch {}',
  '  [Console]::Out.WriteLine("DONE")',
  '}'
].join('\n');

let proc = null;
let waiting = null; // resolve() for the paragraph being spoken

function start() {
  if (proc) return proc;
  // The script goes in as an encoded command so stdin carries only the text to speak.
  proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], { windowsHide: true });
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === 'DONE' && waiting) {
        const w = waiting;
        waiting = null;
        w(true);
      }
    }
  });
  const p = proc;
  p.on('exit', () => {
    if (proc === p) proc = null;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(false);
    }
  });
  return proc;
}

function stop() {
  if (proc) {
    try {
      proc.kill();
    } catch {}
    proc = null;
  }
  if (waiting) {
    const w = waiting;
    waiting = null;
    w(false);
  }
}

const b64 = (s) => Buffer.from(String(s || ''), 'utf8').toString('base64');

function register() {
  ipcMain.handle('tts:voices', () =>
    process.platform !== 'win32'
      ? []
      : new Promise((resolve) => {
          // Reading is about to start: warm up the speech process meanwhile.
          start();
          execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }'],
            { windowsHide: true, timeout: 15000 },
            (err, out) => resolve(err ? [] : String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
          );
        })
  );

  // Speak one paragraph; resolves when it has finished (true) or was stopped (false).
  ipcMain.handle('tts:speak', (_e, text, voice, rate) => {
    if (process.platform !== 'win32') return false;
    if (waiting) stop();
    const p = start();
    const r = Math.max(-10, Math.min(10, Math.round(Number(rate) || 0)));
    return new Promise((resolve) => {
      waiting = resolve;
      // Line breaks would end the command early; base64 keeps the text on one line.
      p.stdin.write(`${b64(String(text).replace(/\s+/g, ' '))}|${voice ? b64(voice) : ''}|${r}\n`);
    });
  });

  ipcMain.handle('tts:stop', () => {
    stop();
    return true;
  });
}

module.exports = { register, stop };

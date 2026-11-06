// Soft answer sounds for the Study stream (Settings → Scholar → Studying: off by default). Made with WebAudio, so
// there are no sound files: a right answer is a gentle two-note rise, a wrong one a single low, neutral tone.

let ctx: AudioContext | null = null;
const audio = () => {
  try {
    const C = window.AudioContext || (window as any).webkitAudioContext;
    if (!C) return null;
    ctx = ctx || new C();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
};

/** One soft sine note: `at` seconds from now, `len` long, rising in and fading out so it never clicks. */
function note(a: AudioContext, freq: number, at: number, len: number, peak: number) {
  const t = a.currentTime + at;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
  osc.connect(gain).connect(a.destination);
  osc.start(t);
  osc.stop(t + len + 0.05);
}

/** Right: two notes a fifth apart, rising. */
export function playRight() {
  const a = audio();
  if (!a) return;
  note(a, 659.25, 0, 0.22, 0.05);
  note(a, 987.77, 0.11, 0.3, 0.045);
}

/** Wrong (or "I don't know"): one low note, not a buzzer. */
export function playWrong() {
  const a = audio();
  if (!a) return;
  note(a, 220, 0, 0.32, 0.05);
}

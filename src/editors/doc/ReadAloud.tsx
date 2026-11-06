import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/core';
import { Pause, Play, Square, SkipForward, SkipBack, X } from 'lucide-react';
import { setting, useSettings } from '../../lib/settings';
import { api } from '../../lib/api';

/**
 * Read aloud with the computer's own voices (offline). Reads the selection, or the document from the
 * cursor, a paragraph at a time, highlighting each paragraph as it's read. On Windows the voices come
 * from the system speech engine; elsewhere from the browser engine.
 */

interface Chunk {
  from: number;
  to: number;
  text: string;
}

function chunksOf(editor: Editor): Chunk[] {
  const { from, to, empty } = editor.state.selection;
  const out: Chunk[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const s = pos + 1;
    const e = pos + node.nodeSize - 1;
    if (!empty && (e < from || s > to)) return false;
    if (empty && e < from) return false;
    const a = Math.max(s, from);
    const b = empty ? e : Math.min(e, to);
    const text = editor.state.doc.textBetween(a, b, ' ', ' ').trim();
    if (text) out.push({ from: a, to: b, text });
    return false;
  });
  return out;
}

const RATES: Record<number, number> = { 0.75: -3, 1: 0, 1.25: 2, 1.5: 4, 2: 7 };
const useNative = () => window.api?.platform === 'win32';

export function ReadAloudBar({ editor, onClose }: { editor: Editor; onClose(): void }) {
  const [chunks] = useState(() => chunksOf(editor));
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [rate, setRate] = useState(() => Number(setting('read.rate')) || 1);
  const [voices, setVoices] = useState<string[]>([]);
  const voiceName = useSettings((s) => (s.values['read.voice'] as string) || '');
  const runId = useRef(0);
  const state = useRef({ rate, voiceName });
  state.current = { rate, voiceName };

  useEffect(() => {
    if (useNative()) api.tts.voices().then(setVoices);
    else setVoices(window.speechSynthesis?.getVoices().map((v) => v.name) || []);
  }, []);

  const stopAll = () => {
    runId.current++;
    if (useNative()) api.tts.stop();
    else window.speechSynthesis?.cancel();
  };

  const speakFrom = async (i: number) => {
    stopAll();
    const id = runId.current;
    if (i >= chunks.length) return onClose();
    setIdx(i);
    setPaused(false);
    const c = chunks[i];
    editor.chain().setTextSelection({ from: c.from, to: c.to }).scrollIntoView().run();
    const { rate: r, voiceName: v } = state.current;
    if (useNative()) {
      await api.tts.speak(c.text, v, RATES[r] ?? 0);
      if (runId.current === id) speakFrom(i + 1);
    } else {
      const u = new SpeechSynthesisUtterance(c.text);
      u.rate = r;
      const voice = window.speechSynthesis.getVoices().find((x) => x.name === v);
      if (voice) u.voice = voice;
      u.onend = () => runId.current === id && speakFrom(i + 1);
      window.speechSynthesis.speak(u);
    }
  };

  useEffect(() => {
    if (!chunks.length) return onClose();
    speakFrom(0);
    return () => stopAll();
  }, []);

  return (
    <div className="read-bar">
      <span className="read-title">Reading aloud</span>
      <button className="icon-btn sm" title="Previous paragraph" onClick={() => speakFrom(Math.max(0, idx - 1))}>
        <SkipBack size={15} />
      </button>
      <button
        className="icon-btn sm"
        title={paused ? 'Resume' : 'Pause'}
        onClick={() => {
          // Pausing stops the paragraph; resuming starts it again from its beginning.
          if (paused) speakFrom(idx);
          else {
            stopAll();
            setPaused(true);
          }
        }}
      >
        {paused ? <Play size={15} /> : <Pause size={15} />}
      </button>
      <button className="icon-btn sm" title="Next paragraph" onClick={() => speakFrom(idx + 1)}>
        <SkipForward size={15} />
      </button>
      <button className="icon-btn sm" title="Stop" onClick={onClose}>
        <Square size={14} />
      </button>
      <span className="muted">
        {Math.min(idx + 1, chunks.length)} / {chunks.length}
      </span>
      <select
        className="select"
        value={rate}
        title="Speed (applies from the next paragraph)"
        onChange={(e) => {
          const r = Number(e.target.value);
          setRate(r);
          useSettings.getState().set({ 'read.rate': r });
        }}
      >
        {[0.75, 1, 1.25, 1.5, 2].map((r) => (
          <option key={r} value={r}>
            {r}×
          </option>
        ))}
      </select>
      <select className="select" value={voiceName} title="Voice (applies from the next paragraph)" onChange={(e) => useSettings.getState().set({ 'read.voice': e.target.value })}>
        <option value="">Default voice</option>
        {voices.map((v) => (
          <option key={v} value={v}>
            {v.replace(/^Microsoft /, '')}
          </option>
        ))}
      </select>
      <button className="icon-btn sm" onClick={onClose} title="Close">
        <X size={15} />
      </button>
    </div>
  );
}

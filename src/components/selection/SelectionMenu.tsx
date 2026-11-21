// The small menu above highlighted text (documents) or a highlighted range of cells (spreadsheets): Copy, Cut, Paste,
// a few formatting buttons, and Ask Claude, which opens the Claude sidebar with the highlight attached as a chip.
// It shows a moment after the mouse is released (Settings → Documents, 0.35 s by default), sits just above the
// highlight (below it when there's no room), and goes away as soon as the person types, clicks elsewhere or scrolls.
// The normal right-click menu is unchanged.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Scissors, ClipboardPaste, Sparkles } from 'lucide-react';
import { useSetting } from '../../lib/settings';
import '../../styles/selection.css';

/** Where the highlight is on screen (viewport pixels): its first line's top and its last line's bottom. */
export interface SelRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface SelAction {
  id: string;
  title: string;
  icon: ReactNode;
  on?: boolean;
  run(): void;
}

const GAP = 6;

export function SelectionMenu({ rect, actions, onAsk, onClose }: { rect: SelRect | null; actions: SelAction[]; onAsk(): void; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);
  // Placed once its size is known: centred over the highlight, never off the window, above unless there's no room.
  useLayoutEffect(() => {
    if (!rect || !box.current) return setPos(null);
    const w = box.current.offsetWidth;
    const h = box.current.offsetHeight;
    const mid = (rect.left + rect.right) / 2;
    const x = Math.max(8, Math.min(window.innerWidth - w - 8, mid - w / 2));
    const above = rect.top - h - GAP;
    const below = above < 48;
    setPos({ x, y: below ? rect.bottom + GAP : above, below });
  }, [rect?.top, rect?.left, rect?.right, rect?.bottom]);
  // Typing, clicking elsewhere, scrolling or leaving the window closes it.
  useEffect(() => {
    if (!rect) return;
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (!e.ctrlKey && !e.metaKey && !e.altKey && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key))) onClose();
    };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [!!rect, onClose]);
  if (!rect) return null;
  const btn = (a: SelAction) => (
    <button
      key={a.id}
      className={`selm-btn ${a.on ? 'on' : ''}`}
      title={a.title}
      aria-label={a.title}
      // Pressing a button never takes the highlight away from the text.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        a.run();
        if (['copy', 'cut', 'paste'].includes(a.id)) onClose();
      }}
    >
      {a.icon}
    </button>
  );
  return createPortal(
    <div ref={box} className={`selm ${pos?.below ? 'below' : ''}`} role="toolbar" aria-label="Selection" style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}>
      {actions.filter((a) => ['copy', 'cut', 'paste'].includes(a.id)).map(btn)}
      <span className="selm-sep" />
      {actions.filter((a) => !['copy', 'cut', 'paste'].includes(a.id)).map(btn)}
      <span className="selm-sep" />
      <button className="selm-btn selm-ai" title="Ask Claude about this (Ctrl+Shift+A)" onMouseDown={(e) => e.preventDefault()} onClick={() => (onAsk(), onClose())}>
        <Sparkles size={14} /> Ask Claude
      </button>
    </div>,
    document.body
  );
}

/** Copy / Cut / Paste for the menu, acting on whatever has focus (the editor), just like the keyboard shortcuts. */
export const clipboardActions = (paste: () => void): SelAction[] => [
  { id: 'copy', title: 'Copy (Ctrl+C)', icon: <Copy size={15} />, run: () => document.execCommand('copy') },
  { id: 'cut', title: 'Cut (Ctrl+X)', icon: <Scissors size={15} />, run: () => document.execCommand('cut') },
  { id: 'paste', title: 'Paste (Ctrl+V)', icon: <ClipboardPaste size={15} />, run: paste }
];

/**
 * When to show the menu: a moment after the mouse is released over a highlight, using the delay from Settings.
 * `measure` gives the highlight's place on screen (null when nothing is highlighted).
 */
export function useSelectionMenu(target: () => HTMLElement | null | undefined, measure: () => SelRect | null, active: boolean) {
  const enabled = useSetting<boolean>('editor.selectionMenu') !== false;
  const delay = Number(useSetting<number>('editor.selectionMenuDelay') ?? 0.35);
  const [rect, setRect] = useState<SelRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    const el = target();
    if (!el || !enabled || !active) return;
    const up = (e: MouseEvent) => {
      if (e.button !== 0) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setRect(measure()), Math.max(0, delay * 1000));
    };
    const down = () => {
      clearTimeout(timer.current);
      setRect(null);
    };
    el.addEventListener('mouseup', up);
    el.addEventListener('mousedown', down);
    return () => {
      clearTimeout(timer.current);
      el.removeEventListener('mouseup', up);
      el.removeEventListener('mousedown', down);
    };
  }, [target(), enabled, delay, active]);
  useEffect(() => {
    if (!active) setRect(null);
  }, [active]);
  return { rect, close: () => setRect(null), refresh: () => setRect(measure()) };
}

import { Sparkles } from 'lucide-react';
import { useAi, toggleAi } from './aiStore';

/** Toolbar button that opens/closes the AI sidebar (Ctrl+J). */
export function AiButton() {
  const open = useAi((s) => s.open);
  return (
    <button className={`ai-toolbar-btn ${open ? 'on' : ''}`} title="AI sidebar (Ctrl+J)" onMouseDown={(e) => e.preventDefault()} onClick={toggleAi}>
      <Sparkles size={15} /> AI
    </button>
  );
}

import { BookOpen } from 'lucide-react';
import { useLookup, toggleLookup } from './lookupStore';

/** Toolbar button that opens/closes the Encyclopedia panel (Ctrl+J). */
export function LookupButton() {
  const open = useLookup((s) => s.open);
  return (
    <button className={`ai-toolbar-btn ${open ? 'on' : ''}`} title="Encyclopedia: explain or define what you highlight (Ctrl+J)" onMouseDown={(e) => e.preventDefault()} onClick={toggleLookup}>
      <BookOpen size={15} /> Encyclopedia
    </button>
  );
}

import { BookOpen } from 'lucide-react';
import { useLookup, toggleLookup } from './lookupStore';

/** Toolbar button that opens/closes the Look up panel (Ctrl+J). */
export function LookupButton() {
  const open = useLookup((s) => s.open);
  return (
    <button className={`ai-toolbar-btn ${open ? 'on' : ''}`} title="Look up: explain or define what you highlight (Ctrl+J)" onMouseDown={(e) => e.preventDefault()} onClick={toggleLookup}>
      <BookOpen size={15} /> Look up
    </button>
  );
}

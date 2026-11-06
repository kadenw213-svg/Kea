import { Sparkles, Square } from 'lucide-react';
import { useAssistant } from './assistantStore';
import { stop } from '../../lib/assistant';

/**
 * Over the file Claude is working on: a soft glowing edge and a pill saying what it's doing right now ("Adding a
 * text box"), with Stop. The editor itself shows each change as it lands (the new element selected, the page
 * scrolled to it), so the student watches the file being built. Hidden while Claude takes its own look.
 */
export function ClaudeWorking({ tabId }: { tabId: string }) {
  const activity = useAssistant((s) => s.activity[tabId]);
  const busy = useAssistant((s) => !!s.chats[tabId]?.busy);
  if (!busy) return null;
  return (
    <div className="claude-working" aria-live="polite">
      <div className="cw-pill">
        <Sparkles size={14} className="cw-spark" />
        <span>{activity || 'Claude is thinking…'}</span>
        <button className="cw-stop" title="Stop Claude (Esc in the Claude tab)" onClick={() => stop(tabId)}>
          <Square size={11} />
        </button>
      </div>
    </div>
  );
}

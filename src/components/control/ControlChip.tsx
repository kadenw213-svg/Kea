import { Plug, Square } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../store';
import { useControlChip } from './controlStore';
import './control.css';

/** A small banner shown while an outside app is driving Kea, with a Stop button that disconnects all apps. */
export function ControlChip() {
  const { active, client, name } = useControlChip();
  if (!active) return null;
  const stop = async () => {
    await api.control.setEnabled(false);
    useControlChip.setState({ active: false });
    toast('Stopped — apps disconnected. Turn Connect an app back on in Settings.', 'info');
  };
  return (
    <div className="control-chip" role="status">
      <Plug size={14} />
      <span>
        <b>{client || 'An app'}</b> is controlling Kea{name ? ` · ${name.replace(/_/g, ' ')}` : ''}
      </span>
      <button className="control-chip-stop" onClick={stop} title="Stop and disconnect all connected apps">
        <Square size={12} /> Stop
      </button>
    </div>
  );
}

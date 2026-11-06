import { create } from 'zustand';
import { api } from '../../lib/api';

/** Live state of an outside app driving Kea, for the "controlling Kea" chip. Fed by the control server's activity. */
interface ControlChipState {
  active: boolean;
  client: string;
  kind: string;
  name?: string;
}
export const useControlChip = create<ControlChipState>(() => ({ active: false, client: '', kind: '' }));

let started = false;
/** Subscribe the chip to control-server activity. Call once at app start. */
export function initControlChip() {
  if (started) return;
  started = true;
  api.control.onActivity((ev) => useControlChip.setState({ active: ev.active, client: ev.client, kind: ev.kind, name: ev.name }));
}

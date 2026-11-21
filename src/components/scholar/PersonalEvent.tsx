// "Add to Kea calendar": the student's own events beside classes and work: birthdays, appointments, personal deadlines,
// bills, recertifications. They can repeat and remind ahead of time (electron/personalEvents.cjs). Clicking one on the
// calendar opens it here to change or delete.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { CalendarPlus, Trash2 } from 'lucide-react';
import { api, type PersonalEvent } from '../../lib/api';
import { toast } from '../../store';
import { reloadScholar } from './scholarStore';

const usePersonal = create<{ open: boolean; event: Partial<PersonalEvent> | null }>(() => ({ open: false, event: null }));

/** Open the form: a new event (on a date, if given), or an existing one by id. */
export async function openPersonalEvent(opts: { id?: string; date?: string } = {}) {
  if (opts.id) {
    const e = (await api.personal.list().catch(() => [])).find((x) => x.id === opts.id);
    if (e) return usePersonal.setState({ open: true, event: e });
  }
  usePersonal.setState({ open: true, event: { date: opts.date } });
}

export function AddEventButton({ date }: { date?: string }) {
  return (
    <button className="btn sm" title="Add a birthday, appointment, deadline or reminder to your Kea calendar" onClick={() => openPersonalEvent({ date })}>
      <CalendarPlus size={14} /> Add event
    </button>
  );
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const REMIND = [
  { v: '', label: 'No reminder' },
  { v: '0', label: 'At the time' },
  { v: '60', label: '1 hour before' },
  { v: '1440', label: '1 day before' },
  { v: '10080', label: '1 week before' },
  { v: '43200', label: '30 days before' }
];

export function PersonalEventDialog() {
  const { open, event } = usePersonal();
  const [f, setF] = useState<Partial<PersonalEvent>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setF({ allDay: true, repeat: 'none', remind: [], ...event, date: event?.date || today() });
  }, [open, event]);
  if (!open) return null;
  const close = () => usePersonal.setState({ open: false, event: null });
  const set = (p: Partial<PersonalEvent>) => setF((x) => ({ ...x, ...p }));
  const editing = !!event?.id;
  const save = async () => {
    setBusy(true);
    try {
      await api.personal.save(f);
      reloadScholar();
      toast(editing ? 'Event saved' : 'Added to your Kea calendar', 'success');
      close();
    } catch (err: any) {
      toast(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!event?.id) return;
    await api.personal.remove(event.id).catch(() => {});
    reloadScholar();
    close();
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog pe-dialog" role="dialog" aria-label={editing ? 'Event' : 'Add to Kea calendar'} onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h2>{editing ? 'Event' : 'Add to Kea calendar'}</h2>
        <label className="field-label" htmlFor="pe-title">
          What
        </label>
        <input id="pe-title" className="input" autoFocus value={f.title || ''} placeholder="Mom’s birthday, dentist, car registration…" onChange={(e) => set({ title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && save()} />
        <div className="pe-row">
          <div>
            <label className="field-label">Date</label>
            <input className="input" type="date" value={f.date || ''} onChange={(e) => set({ date: e.target.value })} />
          </div>
          <label className="pe-check">
            <input type="checkbox" checked={f.allDay !== false} onChange={(e) => set({ allDay: e.target.checked, ...(e.target.checked ? {} : { start: f.start || '09:00' }) })} /> All day
          </label>
          {f.allDay === false && (
            <>
              <div>
                <label className="field-label">From</label>
                <input className="input" type="time" value={f.start || ''} onChange={(e) => set({ start: e.target.value })} />
              </div>
              <div>
                <label className="field-label">To</label>
                <input className="input" type="time" value={f.end || ''} onChange={(e) => set({ end: e.target.value })} />
              </div>
            </>
          )}
        </div>
        <div className="pe-row">
          <div>
            <label className="field-label">Repeats</label>
            <select className="select" value={f.repeat || 'none'} onChange={(e) => set({ repeat: e.target.value as PersonalEvent['repeat'] })}>
              <option value="none">Doesn’t repeat</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
              <option value="yearly">Every year</option>
              <option value="years">Every few years</option>
            </select>
          </div>
          {f.repeat === 'years' && (
            <div>
              <label className="field-label">Every</label>
              <select className="select" value={f.every || 2} onChange={(e) => set({ every: Number(e.target.value) })}>
                {[2, 3, 4, 5, 10].map((n) => (
                  <option key={n} value={n}>
                    {n} years
                  </option>
                ))}
              </select>
            </div>
          )}
          {f.repeat && f.repeat !== 'none' && (
            <div>
              <label className="field-label">Until (optional)</label>
              <input className="input" type="date" value={f.until || ''} onChange={(e) => set({ until: e.target.value || undefined })} />
            </div>
          )}
          <div>
            <label className="field-label">Remind me</label>
            <select className="select" value={String(f.remind?.[0] ?? '')} onChange={(e) => set({ remind: e.target.value === '' ? [] : [Number(e.target.value)] })}>
              {REMIND.map((r) => (
                <option key={r.v} value={r.v}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="field-label">Where (optional)</label>
        <input className="input" value={f.location || ''} onChange={(e) => set({ location: e.target.value })} />
        <label className="field-label" style={{ marginTop: 10 }}>
          Notes (optional)
        </label>
        <textarea className="input" rows={2} value={f.notes || ''} onChange={(e) => set({ notes: e.target.value })} />
        <div className="dialog-actions">
          {editing && (
            <button className="btn sm ghost" style={{ marginRight: 'auto' }} onClick={remove} title={f.repeat !== 'none' ? 'Deletes every repeat of it' : 'Delete'}>
              <Trash2 size={13} /> Delete
            </button>
          )}
          <button className="btn sm" onClick={close}>
            Cancel
          </button>
          <button className="btn primary sm" disabled={busy || !(f.title || '').trim() || !f.date} onClick={save}>
            {editing ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

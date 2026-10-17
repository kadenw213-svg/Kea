// "Hand in": send the open file to one of your classes' assignment folders. Kea opens that folder's own D2L page
// with the file already in its upload box; you check it and press Submit there. Kea never submits for you.
import { useEffect, useState } from 'react';
import { Upload, Loader2, CheckCircle2, Lock } from 'lucide-react';
import { api } from '../../lib/api';
import { MenuButton } from '../Popover';
import { toast } from '../../store';
import '../../styles/handin.css';

type Targets = Awaited<ReturnType<typeof api.scholar.handInTargets>>;

const dueText = (iso: string | null) => {
  if (!iso) return 'No due date';
  const d = new Date(iso);
  const days = Math.round((d.getTime() - Date.now()) / 864e5);
  const when = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return days < 0 ? `Was due ${when}` : `Due ${when}`;
};

function Picker({ path, dirty, close }: { path: string; dirty: boolean; close(): void }) {
  const [targets, setTargets] = useState<Targets | null>(null);
  const [course, setCourse] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    api.scholar
      .handInTargets()
      .then((t) => {
        setTargets(t);
        const first = t.find((c) => c.folders.some((f) => !f.closed));
        setCourse(first?.code || t[0]?.code || null);
      })
      .catch(() => setTargets([]));
  }, []);
  if (!targets) return <div className="hi-pick hi-wait"><Loader2 size={16} className="spin" /> Looking up your assignment folders…</div>;
  if (!targets.some((c) => c.folders.length))
    return <div className="hi-pick hi-wait">No assignment folders found. Kea needs to be signed in to your class site (Scholar → Add a class → From your school).</div>;
  const c = targets.find((x) => x.code === course) || targets[0];
  const send = async (id: number) => {
    setBusy(id);
    try {
      const r = await api.scholar.handIn(c.ou, id, path);
      close();
      toast(r.attached ? 'Your file is attached on the hand-in page. Check it there, then press Submit.' : 'The hand-in page is open. Add your file there, then press Submit.', 'success');
    } catch (err: any) {
      toast(String(err?.message || err), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="hi-pick">
      <div className="hi-head">Hand in this file</div>
      {dirty && <div className="hi-note">This file has unsaved changes. The saved copy is what gets handed in, so save first.</div>}
      <div className="hi-classes">
        {targets.map((t) => (
          <button key={t.code} className={t.code === c.code ? 'on' : ''} onClick={() => setCourse(t.code)}>
            {t.code}
          </button>
        ))}
      </div>
      <div className="hi-list">
        {c.folders.map((f) => (
          <button key={f.id} className={`hi-folder ${f.closed ? 'closed' : ''}`} disabled={f.closed || busy !== null} onClick={() => send(f.id)}>
            <span className="hi-name">{f.name}</span>
            <span className="hi-meta">
              {busy === f.id ? <Loader2 size={12} className="spin" /> : f.closed ? <Lock size={12} /> : f.submitted ? <CheckCircle2 size={12} /> : null}
              {f.closed ? 'Closed' : f.submitted ? 'Already handed in · ' : ''}
              {!f.closed && dueText(f.due)}
            </span>
          </button>
        ))}
      </div>
      <div className="hi-foot">Kea opens the assignment's page with your file attached. You check it and press Submit there.</div>
    </div>
  );
}

export function HandInButton({ path, dirty }: { path: string; dirty: boolean }) {
  return (
    <MenuButton
      button={() => (
        <button className="icon-btn" title="Hand in to a class">
          <Upload size={18} />
        </button>
      )}
    >
      {(close: () => void) => <Picker path={path} dirty={dirty} close={close} />}
    </MenuButton>
  );
}

// "What Claude remembers" in a context folder's window (Kea 0.104): the notes Claude keeps in the folder's
// .kea-memory.md (src/lib/projectMemory.ts), by topic, each with a remove button, plus a box to add one yourself.
import { useEffect, useState } from 'react';
import { Brain, ChevronDown, ChevronUp, FileText, Plus, X } from 'lucide-react';
import { toast } from '../../store';
import { useSetting } from '../../lib/settings';
import { readNotes, saveNotes, memoryPath, TOPICS, type Note, type Topic } from '../../lib/projectMemory';
import type { Project } from '../../lib/projects';

export function FolderNotes({ p, startOpen = false }: { p: Project; startOpen?: boolean }) {
  const on = useSetting<boolean>('projects.memory') !== false;
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [open, setOpen] = useState(startOpen);
  const [text, setText] = useState('');
  const [topic, setTopic] = useState<Topic>('Preferences');
  const load = () => readNotes(p.dir).then(setNotes).catch(() => setNotes([]));
  useEffect(() => {
    setNotes(null);
    load();
    // Claude may save while the window is open.
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [p.dir]);
  const readOnly = p.shared?.access === 'view';
  const save = async (next: Note[]) => {
    try {
      await saveNotes(p, next);
      setNotes(next);
    } catch (err: any) {
      toast(String(err?.message || err), 'error');
    }
  };
  const add = () => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t || !notes) return;
    setText('');
    save([...notes, { topic, text: t }]);
  };
  const n = notes?.length || 0;
  return (
    <div className="cf-notes">
      <button className="cf-notes-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Brain size={14} />
        <b>What Claude remembers</b>
        <span className="muted">{!on ? 'off in Settings' : notes === null ? '' : n ? `${n} note${n === 1 ? '' : 's'}` : 'nothing yet'}</span>
        <span className="cf-grow" />
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="cf-notes-body">
          {!n ? (
            <div className="muted cf-notes-empty">As you work in this folder, Claude saves what it should know next time here: how you like things done, the people, and standing facts. It reads these notes at the start of every conversation about the folder.</div>
          ) : (
            TOPICS.map((t) => {
              const list = notes!.filter((x) => x.topic === t);
              if (!list.length) return null;
              return (
                <div key={t} className="cf-notes-group">
                  <div className="cf-notes-topic">{t}</div>
                  {list.map((x, i) => (
                    <div key={i} className="cf-note">
                      <span>{x.text}</span>
                      {!readOnly && (
                        <button className="icon-btn sm" title="Forget this" onClick={() => save(notes!.filter((y) => y !== x))}>
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              );
            })
          )}
          {!readOnly && (
            <div className="cf-notes-add">
              <select className="select sm" value={topic} onChange={(e) => setTopic(e.target.value as Topic)}>
                {TOPICS.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <input className="input sm" value={text} placeholder="Tell Claude something to remember" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
              <button className="btn sm" disabled={!text.trim()} onClick={add}>
                <Plus size={13} /> Add
              </button>
              <button
                className="icon-btn sm"
                title="Open the notes file"
                onClick={async () => {
                  const { openPaths } = await import('../../lib/open');
                  if (!notes?.length) await saveNotes(p, []);
                  openPaths([memoryPath(p.dir)]);
                }}
              >
                <FileText size={14} />
              </button>
            </div>
          )}
          <div className="muted cf-notes-foot">Kept in this folder{p.shared ? ', just for you: people you share it with have their own' : ''}.</div>
        </div>
      )}
    </div>
  );
}

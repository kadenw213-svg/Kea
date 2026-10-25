// Scan and files: the part of Kea that works on its own, with no PC or class site. Scan paper into a clean PDF (edges
// found, straightened and cleaned up by Android's document scanner), open any file (PDFs, Word, slides, spreadsheets,
// books, pictures…), and keep them here to read, rename, share or save. With classes connected, a file can go straight
// to an assignment's hand-in page.
import { useEffect, useState } from 'react';
import { BookOpen, Camera, ChevronRight, Download, File as FileIcon, FileSpreadsheet, FileText, FolderOpen, Image, Loader2, MoreVertical, Music, Pencil, Plus, Presentation, ScanLine, Share2, Trash2, Upload, Video, X } from 'lucide-react';
import { kindOf } from './Viewer';
import { Kea, KeaData, PhoneFile, appendScan, folders, handInUrl, pagesOf, setPages } from './kea';
import { size, toast, when } from './ui';

const stamp = () => `Scan ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
// (Shown without its extension; the kind says what it is.)
const bare = (name: string) => name.replace(/\.[a-z0-9]{1,5}$/i, '');
const KIND_ICON = { pdf: FileText, doc: FileText, markdown: FileText, text: FileText, epub: BookOpen, sheet: FileSpreadsheet, slides: Presentation, image: Image, audio: Music, video: Video, other: FileIcon };
const KIND_NAME = { pdf: 'PDF', doc: 'Document', markdown: 'Document', text: 'Text', epub: 'Book', sheet: 'Spreadsheet', slides: 'Slides', image: 'Picture', audio: 'Sound', video: 'Video', other: 'File' };

export function FilesTab({ data, read }: { data: KeaData | null; read(path: string, name: string): void }) {
  const [files, setFiles] = useState<PhoneFile[] | null>(null);
  const [open, setOpen] = useState<PhoneFile | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const list = () =>
    Kea.listFiles()
      .then((r) => setFiles(r.files))
      .catch(() => setFiles([]));
  useEffect(() => {
    list();
  }, []);

  const scan = async () => {
    try {
      const s = await Kea.scan({ name: stamp() });
      setPages(s.path, s.pages);
      const r = await Kea.listFiles();
      setFiles(r.files);
      const f = r.files.find((x) => x.path === s.path);
      if (f) {
        setFresh(f.path);
        setOpen(f);
      }
    } catch (e: any) {
      if (!/No scan/.test(String(e?.message))) toast(e);
    }
  };
  const pick = async () => {
    try {
      const f = await Kea.pickFile();
      list();
      read(f.path, f.name);
    } catch (e: any) {
      if (!/No file/.test(String(e?.message))) toast(e);
    }
  };

  return (
    <div className="page">
      <div className="tiles">
        <button className="tile primary" onClick={scan}>
          <ScanLine size={30} />
          <b>Scan</b>
          <span>Paper to a clean PDF</span>
        </button>
        <button className="tile" onClick={pick}>
          <FolderOpen size={30} />
          <b>Open a file</b>
          <span>PDFs, Word, slides, spreadsheets, books</span>
        </button>
      </div>
      <h2>Your files</h2>
      {files === null ? (
        <div className="center pad">
          <Loader2 size={18} className="spin" />
        </div>
      ) : !files.length ? (
        <div className="empty">
          Scans and files you open in Kea (from here, from other apps or from your class site) are kept here, ready to read, share or {data ? 'hand in' : 'save'}.
        </div>
      ) : (
        files.map((f) => {
          const k = kindOf(f.name);
          const Icon = f.kind === 'scan' ? Camera : KIND_ICON[k];
          return (
          <div key={f.path} className="file" onClick={() => read(f.path, f.name)}>
            <span className={`file-ic ${f.kind} k-${k}`}>
              <Icon size={18} />
            </span>
            <span className="file-main">
              <b>{bare(f.name)}</b>
              <span className="muted small">
                {[f.kind === 'scan' ? 'Scan' : KIND_NAME[k], when(f.modified), pagesOf(f.path) ? `${pagesOf(f.path)} page${pagesOf(f.path) === 1 ? '' : 's'}` : null, size(f.size)].filter(Boolean).join(' · ')}
              </span>
            </span>
            <button
              className="icon"
              aria-label="More"
              onClick={(e) => {
                e.stopPropagation();
                setFresh(null);
                setOpen(f);
              }}
            >
              <MoreVertical size={18} />
            </button>
          </div>
          );
        })
      )}
      {open && <FileSheet file={open} data={data} fresh={fresh === open.path} onClose={() => (setOpen(null), setFresh(null))} onChanged={list} read={read} />}
    </div>
  );
}

/** One file's actions: read, rename, share, save to Downloads, hand in (with classes connected), delete. */
function FileSheet({ file, data, fresh, onClose, onChanged, read }: { file: PhoneFile; data: KeaData | null; fresh: boolean; onClose(): void; onChanged(): void; read(path: string, name: string): void }) {
  const [name, setName] = useState(bare(file.name));
  const [path, setPath] = useState(file.path);
  const [handIn, setHandIn] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [adding, setAdding] = useState(false);
  /** Scan more pages onto the end of this scan or PDF (a page forgotten, the back of a sheet). */
  const addPages = async () => {
    setAdding(true);
    try {
      const p = await commit();
      const s = await Kea.scan({ name: 'pages', temp: true });
      const n = await appendScan(p, s.path);
      setPages(p, n);
      onChanged();
      toast(`Added ${s.pages} page${s.pages === 1 ? '' : 's'}: ${n} in all.`);
    } catch (e: any) {
      if (!/No scan/.test(String(e?.message))) toast(e);
    } finally {
      setAdding(false);
    }
  };
  // Renamed when the name is changed and left (the file keeps its place).
  const commit = async () => {
    const n = name.trim();
    if (!n || n === bare(file.name)) return path;
    try {
      const r = await Kea.renameFile({ path, name: n });
      setPages(r.path, pagesOf(path) || 0);
      setPath(r.path);
      onChanged();
      return r.path;
    } catch (e) {
      toast(e);
      return path;
    }
  };
  return (
    <div className="sheet-bg" onClick={() => commit().then(onClose)}>
      <div className="sheet file-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <b>{fresh ? `Scanned ${pagesOf(path) || ''} page${pagesOf(path) === 1 ? '' : 's'}` : 'File'}</b>
          <button className="icon" aria-label="Close" onClick={() => commit().then(onClose)}>
            <X size={20} />
          </button>
        </div>
        <label className="field">
          <span>Name</span>
          <span className="field-row">
            <Pencil size={15} />
            <input value={name} onChange={(e) => setName(e.target.value)} onBlur={commit} />
          </span>
        </label>
        <div className="grid2">
          <button className="btn" onClick={async () => { const p = await commit(); read(p, p.split('/').pop() || name); }}>
            <FileText size={16} /> Open
          </button>
          <button className="btn" onClick={async () => Kea.share({ file: await commit(), name })}>
            <Share2 size={16} /> Share
          </button>
          <button className="btn" onClick={async () => Kea.saveCopy({ file: await commit(), name }).then((r) => toast(`Saved to Downloads as ${r.name}`)).catch(toast)}>
            <Download size={16} /> Save to Downloads
          </button>
          <button className="btn" onClick={async () => Kea.openWith({ path: await commit() }).catch(toast)}>
            <FolderOpen size={16} /> Open in another app
          </button>
          {/\.pdf$/i.test(path) && (
            <button className="btn" disabled={adding} onClick={addPages}>
              {adding ? <Loader2 size={16} className="spin" /> : <Plus size={16} />} Scan more pages
            </button>
          )}
          {data && (
            <button className="btn" onClick={() => setHandIn(!handIn)}>
              <Upload size={16} /> Hand in
            </button>
          )}
        </div>
        {handIn && data && <HandIn data={data} file={path} onPicked={(f) => setName(f)} />}
        <div className="sheet-foot">
          {confirm ? (
            <>
              <span className="muted small">Delete “{name}” from the phone?</span>
              <button className="btn danger" onClick={() => Kea.deleteFile({ path }).then(onChanged).then(onClose).catch(toast)}>
                Delete
              </button>
              <button className="btn" onClick={() => setConfirm(false)}>
                Keep
              </button>
            </>
          ) : (
            <button className="btn ghost danger-text" onClick={() => setConfirm(true)}>
              <Trash2 size={16} /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The class's assignments that take a file: picking one opens its hand-in page with the file attached. */
function HandIn({ data, file, onPicked }: { data: KeaData; file: string; onPicked(name: string): void }) {
  const [targets, setTargets] = useState<Awaited<ReturnType<typeof folders>> | null>(null);
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    folders(data)
      .then((t) => {
        setTargets(t);
        setCode(t.find((c) => c.folders.some((f) => !f.closed))?.code || t[0]?.code || null);
      })
      .catch(() => setTargets([]));
  }, []);
  if (!targets)
    return (
      <div className="center pad">
        <Loader2 size={16} className="spin" /> Finding your assignments…
      </div>
    );
  if (!targets.length) return <p className="note">Kea couldn’t reach your class site. Sign in under Settings → Class site, then try again.</p>;
  const c = targets.find((t) => t.code === code);
  return (
    <div className="handin">
      <div className="chips">
        {targets.map((t) => (
          <button key={t.code} className={t.code === code ? 'on' : ''} onClick={() => setCode(t.code)}>
            {t.code}
          </button>
        ))}
      </div>
      {c?.folders.length ? (
        c.folders.map((f) => (
          <button key={f.id} className="file link" disabled={f.closed} onClick={() => (onPicked(f.name), Kea.handIn({ url: handInUrl(data, c.ou, f.id), file }))}>
            <Upload size={16} />
            <span className="file-main">
              <b>{f.name}</b>
              <span className="muted small">{f.closed ? 'Closed' : f.due ? `Due ${new Date(f.due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : 'No due date'}</span>
            </span>
            <ChevronRight size={16} />
          </button>
        ))
      ) : (
        <p className="muted small">No assignments in {code} take a file right now.</p>
      )}
      <p className="muted small">Kea opens the assignment’s hand-in page with your file attached. Check it and press Submit there.</p>
    </div>
  );
}

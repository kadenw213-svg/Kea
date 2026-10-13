import { useEffect, useMemo, useState } from 'react';
import { FileText, Sheet, FileCode2, FolderOpen, Combine, Images, Search, X, FolderSearch, FileType2, Presentation } from 'lucide-react';
import { api, RecentEntry } from '../lib/api';
import { newFile, openPaths, openWithDialog } from '../lib/open';
import { FileIcon } from './FileIcon';
import { timeAgo } from '../lib/util';
import { useTabs, toast } from '../store';
import { mergePdfs, imagesToPdf } from '../lib/pdfTools';
import { MenuButton } from './Popover';
import { MoreVertical } from 'lucide-react';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function HomeScreen({ visible }: { visible: boolean }) {
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (visible) api.getRecent().then(setRecent);
  }, [visible]);

  const filtered = useMemo(
    () => recent.filter((r) => !query || r.name.toLowerCase().includes(query.toLowerCase()) || r.path.toLowerCase().includes(query.toLowerCase())),
    [recent, query]
  );

  const merge = async () => {
    const files = await api.openDialog({ title: 'Choose PDFs to combine', multi: true, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (files.length < 1) return;
    try {
      const bytes = await mergePdfs(files.map((f) => f.data));
      useTabs.getState().addTab({ kind: 'pdf', name: 'Combined.pdf', path: null, data: bytes });
      toast(`Combined ${files.length} PDFs. Reorder pages in the sidebar, then save.`, 'success');
    } catch (e: any) {
      toast(`Couldn't combine: ${e.message}`, 'error');
    }
  };

  const imgToPdf = async () => {
    const files = await api.openDialog({
      title: 'Choose images',
      multi: true,
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    });
    if (!files.length) return;
    try {
      const bytes = await imagesToPdf(files);
      useTabs.getState().addTab({ kind: 'pdf', name: 'Images.pdf', path: null, data: bytes });
    } catch (e: any) {
      toast(`Couldn't convert: ${e.message}`, 'error');
    }
  };

  const openPdf = async () => {
    const files = await api.openDialog({ title: 'Open PDF', multi: true, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (files.length) openPaths(files.map((f) => f.path));
  };

  return (
    <div className="home">
      <div className="home-inner">
        <h1 className="home-title">{greeting()}</h1>
        <p className="home-sub">Open anything, or start something new. Everything stays on this computer.</p>

        <section>
          <div className="home-section-title">Start new</div>
          <div className="card-row">
            <button className="start-card" onClick={() => newFile('doc')}>
              <div className="start-thumb doc">
                <FileText size={34} />
              </div>
              <span>Document</span>
            </button>
            <button className="start-card" onClick={() => newFile('sheet')}>
              <div className="start-thumb sheet">
                <Sheet size={34} />
              </div>
              <span>Spreadsheet</span>
            </button>
            <button className="start-card" onClick={() => newFile('slides')}>
              <div className="start-thumb slides">
                <Presentation size={34} />
              </div>
              <span>Presentation</span>
            </button>
            <button className="start-card" onClick={() => newFile('code')}>
              <div className="start-thumb code">
                <FileCode2 size={34} />
              </div>
              <span>Text file</span>
            </button>
            <button className="start-card" onClick={openPdf}>
              <div className="start-thumb pdf">
                <FileType2 size={34} />
              </div>
              <span>Edit a PDF</span>
            </button>
          </div>
        </section>

        <section>
          <div className="home-section-title">PDF tools</div>
          <div className="tool-row">
            <button className="tool-chip" onClick={merge}>
              <Combine size={18} /> Combine PDFs
            </button>
            <button className="tool-chip" onClick={imgToPdf}>
              <Images size={18} /> Images to PDF
            </button>
            <button className="tool-chip" onClick={openWithDialog}>
              <FolderOpen size={18} /> Open any file
            </button>
          </div>
        </section>

        <section className="recent">
          <div className="recent-head">
            <div className="home-section-title" style={{ margin: 0 }}>
              Recent files
            </div>
            <div className="search-box">
              <Search size={16} />
              <input placeholder="Search recent" value={query} onChange={(e) => setQuery(e.target.value)} />
              {query && (
                <button className="icon-btn sm" onClick={() => setQuery('')}>
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
          {filtered.length === 0 ? (
            <div className="recent-empty">
              {recent.length === 0 ? (
                <>
                  <FolderOpen size={40} strokeWidth={1.4} />
                  <div>No recent files yet</div>
                  <div className="muted">
                    Press <span className="kbd-chip">Ctrl</span> + <span className="kbd-chip">O</span> or drop files anywhere on this window
                  </div>
                </>
              ) : (
                <div>No matches</div>
              )}
            </div>
          ) : (
            <div className="recent-list">
              {filtered.map((r) => (
                <div key={r.path} className="recent-item" onClick={() => openPaths([r.path])}>
                  <FileIcon name={r.name} size={20} />
                  <div className="recent-name">
                    <div>{r.name}</div>
                    <div className="recent-path">{r.path}</div>
                  </div>
                  <div className="recent-time">{timeAgo(r.openedAt)}</div>
                  <span onClick={(e) => e.stopPropagation()}>
                    <MenuButton
                      align="right"
                      button={() => (
                        <button className="icon-btn sm">
                          <MoreVertical size={16} />
                        </button>
                      )}
                    >
                      {(close) => (
                        <>
                          <button className="menu-item" onClick={() => (api.showInFolder(r.path), close())}>
                            <FolderSearch size={16} /> Show in folder
                          </button>
                          <button className="menu-item" onClick={async () => (setRecent(await api.removeRecent(r.path)), close())}>
                            <X size={16} /> Remove from list
                          </button>
                        </>
                      )}
                    </MenuButton>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

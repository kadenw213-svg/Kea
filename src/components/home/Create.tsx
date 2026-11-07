// Home's "Create" bar: Kea's studio in one compact row. New document, spreadsheet and presentation up front; PDF tools,
// templates and the other editors one click further.
import { ChevronDown, Clapperboard, Combine, FileCode2, FileText, FileType2, FolderOpen, ImagePlus, Images, LayoutTemplate, MoreHorizontal, Presentation, Sheet } from 'lucide-react';
import { newFile, openPaths, openWithDialog } from '../../lib/open';
import { api } from '../../lib/api';
import { mergePdfs, imagesToPdf } from '../../lib/pdfTools';
import { toast, useTabs } from '../../store';
import { MenuButton } from '../Popover';

async function merge() {
  const picked = await api.openDialog({ title: 'Choose PDFs to combine', multi: true, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (!picked.length) return;
  if (picked.length < 2) return toast('Choose two or more PDFs to combine (hold Ctrl to pick several).');
  try {
    const bytes = await mergePdfs(picked.map((f) => f.data));
    useTabs.getState().addTab({ kind: 'pdf', name: 'Combined.pdf', path: null, data: bytes });
    toast(`Combined ${picked.length} PDFs. Reorder pages in the sidebar, then save.`, 'success');
  } catch (e: any) {
    toast(`Couldn't combine: ${e.message}`, 'error');
  }
}
async function imgToPdf() {
  const picked = await api.openDialog({ title: 'Choose images', multi: true, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
  if (!picked.length) return;
  try {
    useTabs.getState().addTab({ kind: 'pdf', name: 'Images.pdf', path: null, data: await imagesToPdf(picked) });
  } catch (e: any) {
    toast(`Couldn't convert: ${e.message}`, 'error');
  }
}
async function openPdf() {
  const picked = await api.openDialog({ title: 'Open PDF', multi: true, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (picked.length) openPaths(picked.map((f) => f.path));
}

export function CreateBar({ tools, onTemplates }: { tools: boolean; onTemplates: () => void }) {
  return (
    <div className="create-bar" role="toolbar" aria-label="Create">
      <button className="create-btn" onClick={() => newFile('doc')}>
        <span className="create-ic doc">
          <FileText size={17} />
        </span>
        Document
      </button>
      <button className="create-btn" onClick={() => newFile('sheet')}>
        <span className="create-ic sheet">
          <Sheet size={17} />
        </span>
        Spreadsheet
      </button>
      <button className="create-btn" onClick={() => newFile('slides')}>
        <span className="create-ic slides">
          <Presentation size={17} />
        </span>
        Presentation
      </button>
      <MenuButton
        button={() => (
          <button className="create-btn">
            <span className="create-ic pdf">
              <FileType2 size={17} />
            </span>
            PDF
            <ChevronDown size={14} className="muted" />
          </button>
        )}
      >
        {(close) => (
          <>
            <button className="menu-item" onClick={() => (close(), openPdf())}>
              <FileType2 size={16} /> Edit a PDF
            </button>
            {tools && (
              <>
                <button className="menu-item" onClick={() => (close(), merge())}>
                  <Combine size={16} /> Combine PDFs
                </button>
                <button className="menu-item" onClick={() => (close(), imgToPdf())}>
                  <Images size={16} /> Images to PDF
                </button>
              </>
            )}
          </>
        )}
      </MenuButton>
      <button className="create-btn" onClick={onTemplates}>
        <span className="create-ic tpl">
          <LayoutTemplate size={17} />
        </span>
        Templates
      </button>
      <MenuButton
        button={() => (
          <button className="create-btn quiet" title="More">
            <MoreHorizontal size={17} />
            More
          </button>
        )}
      >
        {(close) => (
          <>
            <button className="menu-item" onClick={() => (close(), newFile('code'))}>
              <FileCode2 size={16} /> Text file
            </button>
            <button className="menu-item" onClick={() => (close(), newFile('image'))}>
              <ImagePlus size={16} /> Image
            </button>
            <button className="menu-item" onClick={() => (close(), newFile('video'))}>
              <Clapperboard size={16} /> Video
            </button>
            {tools && (
              <button className="menu-item" onClick={() => (close(), openWithDialog())}>
                <FolderOpen size={16} /> Open a file…
              </button>
            )}
          </>
        )}
      </MenuButton>
    </div>
  );
}

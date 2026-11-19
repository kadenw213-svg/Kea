import { useEffect, useRef, useState } from 'react';
import { Printer, X, Download } from 'lucide-react';
import { api } from '../lib/api';
import { usePrintPreview, type PrintRequest } from '../lib/printPreview';
import { exportFile } from '../lib/save';
import { loadPdf } from '../editors/pdf/pdfjs';
import { toast } from '../store';
import '../styles/printpreview.css';

/** One page of the preview, drawn from the same PDF that Save as PDF writes. */
function Page({ pdf, n }: { pdf: any; n: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let dead = false;
    (async () => {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const width = 620;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale: (width / base.width) * dpr });
      const c = ref.current;
      if (!c || dead) return;
      c.width = vp.width;
      c.height = vp.height;
      c.style.width = `${vp.width / dpr}px`;
      c.style.height = `${vp.height / dpr}px`;
      await page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
    })().catch(() => {});
    return () => {
      dead = true;
    };
  }, [pdf, n]);
  return (
    <div className="pp-page" data-page={n}>
      <canvas ref={ref} />
      <div className="pp-num">Page {n}</div>
    </div>
  );
}

function Preview({ req }: { req: PrintRequest }) {
  const [pdf, setPdf] = useState<any>(null);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bytes = useRef<Uint8Array | null>(null);

  const close = (printed: boolean) => {
    usePrintPreview.setState({ req: null });
    req.resolve(printed);
  };

  useEffect(() => {
    let dead = false;
    let doc: any = null;
    (async () => {
      try {
        const b = await api.pdfFromHtml(req.html, req.opts);
        bytes.current = b;
        doc = await loadPdf(b);
        if (dead) return doc.destroy();
        setPdf(doc);
        setPages(doc.numPages);
      } catch (err: any) {
        if (!dead) setError(err?.message || 'Kea could not lay out the pages.');
      }
    })();
    return () => {
      dead = true;
      doc?.destroy();
    };
  }, [req.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const print = async () => {
    setBusy(true);
    try {
      const ok = await api.printHtml(req.html, req.opts);
      if (ok) close(true);
    } catch (err: any) {
      toast(`Print failed: ${err?.message || err}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const save = () => exportFile(`${req.name}.pdf`, { name: 'PDF', ext: 'pdf', build: async () => bytes.current! });

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div className="dialog pp-dialog" role="dialog" aria-label="Print preview" onKeyDown={(e) => e.stopPropagation()}>
        <div className="pp-head">
          <h2>Print preview</h2>
          <span className="pp-count">{pdf ? `${pages} page${pages === 1 ? '' : 's'}` : ''}</span>
          <button className="icon-btn sm" onClick={() => close(false)} title="Close">
            <X size={16} />
          </button>
        </div>
        <div className="pp-body">
          {error ? (
            <p className="pp-msg">{error}</p>
          ) : !pdf ? (
            <p className="pp-msg">Laying out the pages…</p>
          ) : (
            Array.from({ length: pages }, (_, i) => <Page key={i} pdf={pdf} n={i + 1} />)
          )}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => close(false)}>
            Cancel
          </button>
          <button className="btn" onClick={save} disabled={!pdf}>
            <Download size={14} /> Save as PDF
          </button>
          <button className="btn primary" onClick={print} disabled={!pdf || busy} autoFocus>
            <Printer size={14} /> Print…
          </button>
        </div>
      </div>
    </div>
  );
}

export function PrintPreview() {
  const req = usePrintPreview((s) => s.req);
  return req ? <Preview key={req.id} req={req} /> : null;
}

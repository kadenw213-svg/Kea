import { memo, useEffect, useRef, useState } from 'react';
import { CloudDownload } from 'lucide-react';
import type { FilePreview } from '../../lib/api';
import { cachedPreview, getPreview } from '../../lib/previews';
import { extOf } from '../../lib/fileTypes';
import { FileIcon } from '../FileIcon';
import { SlideView } from '../../editors/slides/SlideView';

// One shared observer scales every preview "page" to its card width (pages render at a fixed size).
const scaler = new ResizeObserver((entries) => {
  for (const e of entries) {
    const el = e.target as HTMLElement;
    const natural = Number(el.dataset.w) || 600;
    el.style.setProperty('--s', String(e.contentRect.width / natural));
  }
});
const lazy = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (e.isIntersecting) (e.target as any).__show?.();
  },
  { rootMargin: '300px' }
);

function Scaled({ w, children, className }: { w: number; children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    scaler.observe(el);
    return () => scaler.unobserve(el);
  }, []);
  return (
    <div ref={ref} className={`pv-scale ${className || ''}`} data-w={w}>
      <div className="pv-natural" style={{ width: w }}>
        {children}
      </div>
    </div>
  );
}

function Body({ p, name }: { p: FilePreview; name: string }) {
  switch (p.type) {
    case 'image': {
      const isPage = extOf(name) === 'pdf';
      return <img className={`pv-img ${isPage ? 'page' : 'photo'}`} src={p.src} alt="" draggable={false} />;
    }
    case 'doc':
      return (
        <Scaled w={520} className="pv-page">
          <div className="pv-doc" dangerouslySetInnerHTML={{ __html: p.html }} />
        </Scaled>
      );
    case 'text':
      return (
        <Scaled w={520} className="pv-page">
          <pre className="pv-text">{p.text}</pre>
        </Scaled>
      );
    case 'grid':
      return (
        <Scaled w={520} className="pv-page grid">
          <table className="pv-grid">
            <tbody>
              {p.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Scaled>
      );
    case 'slide':
      return (
        <div className="pv-slide-wrap">
          <Scaled w={p.w} className="pv-slide">
            <SlideView slide={p.slide} w={p.w} h={p.h} font={p.font} />
          </Scaled>
        </div>
      );
    default:
      return null;
  }
}

function PreviewInner({ path, name, mtime, online, iconOnly }: { path: string; name: string; mtime?: number; online?: boolean; iconOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [p, setP] = useState<FilePreview | undefined>(() => cachedPreview(path, mtime));

  useEffect(() => {
    if (online || p || iconOnly) return;
    const el = host.current as any;
    let alive = true;
    el.__show = () => {
      lazy.unobserve(el);
      getPreview(path, mtime).then((v) => alive && setP(v));
    };
    lazy.observe(el);
    return () => {
      alive = false;
      lazy.unobserve(el);
    };
  }, [path, mtime, online, iconOnly]);

  const empty = iconOnly || !p || p.type === 'none';
  return (
    <div ref={host} className={`pv ${empty ? 'empty' : ''} ${p ? 'ready' : ''}`}>
      {empty ? (
        <div className="pv-icon">
          <FileIcon name={name} size={34} />
          <span>{extOf(name).toUpperCase()}</span>
        </div>
      ) : (
        <Body p={p!} name={name} />
      )}
      {online && (
        <span className="pv-badge" title="Stored online. Opening it downloads it to this PC.">
          <CloudDownload size={13} /> Online
        </span>
      )}
    </div>
  );
}

export const Preview = memo(PreviewInner);

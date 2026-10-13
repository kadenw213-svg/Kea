import { memo } from 'react';
import type { El, Slide } from './model';

interface Props {
  slide: Slide;
  w: number;
  h: number;
  font: string;
  editingId?: string | null;
  textRef?: (el: HTMLDivElement | null) => void;
  interactive?: boolean;
}

function ShapeSvg({ el }: { el: El }) {
  const sw = el.stroke ? el.strokeW || 1 : 0;
  if (el.shape === 'triangle') {
    return (
      <svg className="sv-svg" width={el.w} height={el.h} viewBox={`0 0 ${el.w} ${el.h}`}>
        <polygon points={`${el.w / 2},${sw / 2} ${el.w - sw / 2},${el.h - sw / 2} ${sw / 2},${el.h - sw / 2}`} fill={el.fill || 'none'} stroke={el.stroke || 'none'} strokeWidth={sw} />
      </svg>
    );
  }
  if (el.shape === 'line' || el.shape === 'arrow') {
    const [x1, y1, x2, y2] = [el.flipH ? el.w : 0, el.flipV ? el.h : 0, el.flipH ? 0 : el.w, el.flipV ? 0 : el.h];
    const id = `ah-${el.id}`;
    return (
      <svg className="sv-svg" width={Math.max(el.w, 1)} height={Math.max(el.h, 1)} style={{ overflow: 'visible' }}>
        {el.shape === 'arrow' && (
          <defs>
            <marker id={id} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={el.stroke || '#000'} />
            </marker>
          </defs>
        )}
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={el.stroke || '#000'} strokeWidth={el.strokeW || 1.5} strokeLinecap="round" markerEnd={el.shape === 'arrow' ? `url(#${id})` : undefined} />
      </svg>
    );
  }
  return null;
}

function ElView({ el, font, editing, textRef, interactive }: { el: El; font: string; editing: boolean; textRef?: Props['textRef']; interactive?: boolean }) {
  const transform = [el.rot ? `rotate(${el.rot}deg)` : '', el.type === 'image' && el.flipH ? 'scaleX(-1)' : '', el.type === 'image' && el.flipV ? 'scaleY(-1)' : ''].filter(Boolean).join(' ');
  const style: React.CSSProperties = { left: el.x, top: el.y, width: el.w, height: el.h, transform: transform || undefined };
  const cls = `sv-el${el.locked ? ' locked' : ''}`;
  if (el.type === 'image') {
    return (
      <div className={cls} data-el={el.locked || !interactive ? undefined : el.id} style={style}>
        <img src={el.src} draggable={false} alt="" />
      </div>
    );
  }
  const svgShape = el.shape === 'triangle' || el.shape === 'line' || el.shape === 'arrow';
  const box: React.CSSProperties = svgShape
    ? {}
    : {
        background: el.fill || undefined,
        border: el.stroke && el.strokeW ? `${el.strokeW}px solid ${el.stroke}` : undefined,
        borderRadius: el.shape === 'ellipse' ? '50%' : el.shape === 'roundRect' ? Math.min(el.w, el.h) * 0.16 : undefined
      };
  return (
    <div className={cls} data-el={el.locked || !interactive ? undefined : el.id} style={{ ...style, ...box }}>
      {svgShape && <ShapeSvg el={el} />}
      {el.html !== undefined && (
        <div className={`sv-text v-${el.valign || 'top'}`} style={{ fontSize: el.size || 18, color: el.color || '#000000', fontFamily: `${quoteFont(el.font || font)}, Calibri, Arial, sans-serif` }}>
          <div
            className="sv-text-inner"
            ref={editing ? textRef : undefined}
            contentEditable={editing}
            suppressContentEditableWarning
            spellCheck={editing}
            dangerouslySetInnerHTML={editing ? undefined : { __html: el.html || '' }}
          />
        </div>
      )}
    </div>
  );
}

const quoteFont = (f: string) => (/^['"]/.test(f) || !/\s/.test(f) ? f : `'${f}'`);

function SlideViewInner({ slide, w, h, font, editingId, textRef, interactive }: Props) {
  return (
    <div className="slide-view" style={{ width: w, height: h, background: slide.bg, fontFamily: font }}>
      {slide.els.map((el) => (
        <ElView key={el.id} el={el} font={font} editing={editingId === el.id} textRef={textRef} interactive={interactive} />
      ))}
    </div>
  );
}

export const SlideView = memo(SlideViewInner);

/** CSS needed to render slides outside the app (PDF export / print). */
export const SLIDE_CSS = `
.slide-view{position:relative;overflow:hidden;line-height:1.15;color:#000}
.sv-el{position:absolute;box-sizing:border-box;transform-origin:center}
.sv-el img{width:100%;height:100%;object-fit:fill;display:block}
.sv-svg{position:absolute;inset:0;overflow:visible}
.sv-text{position:absolute;inset:0;padding:3.6px 7.2px;display:flex;flex-direction:column;overflow:visible;word-wrap:break-word}
.sv-text.v-middle{justify-content:center}.sv-text.v-bottom{justify-content:flex-end}
.sv-text-inner{outline:none;min-height:1em}
.sv-text p{margin:0}
.sv-text ul,.sv-text ol{margin:0;padding-left:1.25em}
.sv-text li{margin:0 0 .25em}
`;

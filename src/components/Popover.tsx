import { useEffect, useLayoutEffect, useRef, useState, ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  anchor: HTMLElement | null;
  open: boolean;
  onClose(): void;
  children: ReactNode;
  align?: 'left' | 'right';
}

export function Popover({ anchor, open, onClose, children, align = 'left' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: -9999, left: -9999 });

  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) return;
    const a = anchor.getBoundingClientRect();
    const p = ref.current.getBoundingClientRect();
    let left = align === 'left' ? a.left : a.right - p.width;
    let top = a.bottom + 6;
    left = Math.max(8, Math.min(left, window.innerWidth - p.width - 8));
    if (top + p.height > window.innerHeight - 8) top = Math.max(8, a.top - p.height - 6);
    setPos({ top, left });
  }, [open, anchor, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, anchor, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      className="popover"
      style={pos}
      onMouseDown={(e) => {
        // Keep editor focus/selection while clicking menu items, but let inputs focus.
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') e.preventDefault();
      }}
    >
      {children}
    </div>,
    document.body
  );
}

/** Button that toggles a popover menu. */
export function MenuButton({
  button,
  children,
  align,
  title
}: {
  button: (open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const close = () => setOpen(false);
  return (
    <>
      <span
        ref={setAnchor}
        title={title}
        style={{ display: 'inline-flex', flexShrink: 0 }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        {button(open)}
      </span>
      <Popover anchor={anchor} open={open} onClose={close} align={align}>
        {children(close)}
      </Popover>
    </>
  );
}

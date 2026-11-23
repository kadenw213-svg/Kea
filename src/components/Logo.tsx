import { useId } from 'react';
import markSvg from './kea-mark.svg?raw';

/**
 * Kea's logo (Kea 0.101): the kea drawn in the logo colour (Settings → Look & feel → Logo colour, `--logo-1/2`) on a
 * square glass tile that matches Kea's other buttons. `bare`: the bird alone, without the tile. The app icon is drawn
 * from build/logo.svg by scripts/make-icon.cjs. Each copy gets its own gradient id: a shared id breaks every copy
 * when the first one is hidden.
 */
export function Logo({ size = 22, className = '', bare = false }: { size?: number; className?: string; bare?: boolean }) {
  const id = `kea-ink-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <span
      className={`kea-logo ${bare ? 'bare' : 'tile'} ${className}`}
      style={{ width: size, height: size }}
      aria-label="Kea"
      dangerouslySetInnerHTML={{ __html: markSvg.split('kea-mark-ink').join(id) }}
    />
  );
}

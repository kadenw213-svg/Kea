import logoSvg from '../../build/logo.svg?raw';

/** Slate's logo. The same SVG (build/logo.svg) is rendered into the app icon by scripts/make-icon.cjs. */
export function Logo({ size = 22, className = '' }: { size?: number; className?: string }) {
  return <span className={`slate-logo ${className}`} style={{ width: size, height: size }} aria-label="Slate" dangerouslySetInnerHTML={{ __html: logoSvg }} />;
}

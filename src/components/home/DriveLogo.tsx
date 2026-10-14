import type { DriveId } from '../../lib/api';

/** Simple brand-coloured marks for the cloud drives (drawn here so nothing is fetched online). */
export function DriveLogo({ id, size = 18 }: { id: DriveId | string; size?: number }) {
  const s = size;
  switch (id) {
    case 'onedrive':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M9.5 8.2a5 5 0 0 1 8.6 2.3A3.7 3.7 0 0 1 18.6 18H7a4 4 0 0 1-.8-7.9 5 5 0 0 1 3.3-1.9z" fill="#4c9be8" />
          <path d="M9.5 8.2a5 5 0 0 1 8.6 2.3 3.6 3.6 0 0 0-3.3 1.2L9 9.2z" fill="#2b74c9" />
        </svg>
      );
    case 'gdrive':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M8.6 3.5h6.8l6.1 10.6h-6.8z" fill="#fbbc04" />
          <path d="M8.6 3.5 2.5 14.1l3.4 5.9 6.1-10.6z" fill="#34a853" />
          <path d="M5.9 20h12.2l3.4-5.9H9.3z" fill="#4285f4" />
        </svg>
      );
    case 'dropbox':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden fill="#3d8bff">
          <path d="m7 3.5-5 3.2 5 3.2 5-3.2zm10 0-5 3.2 5 3.2 5-3.2zM2 13.1l5 3.2 5-3.2-5-3.2zm15-3.2-5 3.2 5 3.2 5-3.2zM7 17.4l5 3.2 5-3.2-5-3.2z" />
        </svg>
      );
    case 'icloud':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M7 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.6A3.7 3.7 0 0 1 17.6 18.5z" fill="#c4c7c5" />
        </svg>
      );
    default:
      return null;
  }
}

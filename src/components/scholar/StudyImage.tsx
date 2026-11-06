// A question's or card's picture (identify the specimen, the structure, the labeled part), with its credit. Pictures
// are saved with the sets (small JPEGs), so they show offline; each is read once and kept for the session.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

const cache = new Map<string, Promise<string | null>>();
const load = (rel: string) => {
  if (!cache.has(rel)) cache.set(rel, api.scholar.studyImage(rel).catch(() => null));
  return cache.get(rel)!;
};

export function StudyImage({ src, credit, small = false }: { src?: string; credit?: string; small?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (src) load(src).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [src]);
  if (!src || !url) return null;
  return (
    <figure className={`st-image ${small ? 'small' : ''}`} onClick={(e) => e.stopPropagation()}>
      <img src={url} alt="" draggable={false} />
      {credit && <figcaption>{credit}</figcaption>}
    </figure>
  );
}

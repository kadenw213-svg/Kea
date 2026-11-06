// Find faces in an image with the on-device face finder (YuNet) in the Kea engine. Boxes are fractions of the image.
import { api } from './api';
import { setting } from './settings';

export interface Face {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

export async function detectFaces(img: { data: Uint8ClampedArray; width: number; height: number }): Promise<Face[]> {
  if (!api.engine) throw new Error('Face finding needs the Kea desktop app.');
  const installed = (await api.models.state('faces')).filter((m) => m.installed);
  if (!installed.length) throw new Error('No face finder is installed. Open Settings → AI image tools and download “Face finder (YuNet)” (0.2 MB), then try again.');
  const r = await api.engine.faces(installed[0].id, new Uint8Array(img.data).buffer, img.width, img.height, String(setting('ai.accel') || 'auto'));
  return r.faces;
}

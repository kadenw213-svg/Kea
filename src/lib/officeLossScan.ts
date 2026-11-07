// What a Word, Excel or PowerPoint file holds that Kea can't keep yet. Only JSZip, so it can be tested on its own.
import JSZip from 'jszip';
import { extOf } from './fileTypes';

const has = (s: string, ...needles: string[]) => needles.some((n) => s.includes(n));

/** What in this Office file Kea would drop on saving, in plain words ([] when nothing, or not an Office file). */
export async function officeLosses(name: string, bytes: Uint8Array | null | undefined): Promise<string[]> {
  const ext = extOf(name);
  if (!bytes?.length || !['docx', 'docm', 'xlsx', 'xlsm', 'pptx', 'pptm'].includes(ext)) return [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return [];
  }
  const files = Object.keys(zip.files);
  const text = async (p: string) => (zip.file(p) ? await zip.file(p)!.async('string') : '');
  const under = (dir: string) => files.some((f) => f.startsWith(dir) && !f.endsWith('/'));
  const out: string[] = [];
  if (under('word/') || ext.startsWith('doc')) {
    const doc = await text('word/document.xml');
    if (has(doc, 'drawingml/2006/chart"', '<c:chart ')) out.push('charts');
    if (has(doc, 'drawingml/2006/diagram"', '<dgm:relIds')) out.push('SmartArt');
    if (has(doc, '<w:txbxContent', '<wps:txbx')) out.push('text boxes');
    else if (has(doc, '<wps:wsp', '<v:shape ') && !has(doc, '<v:imagedata')) out.push('shapes');
    if (has(doc, '<m:oMath')) out.push('Word equations');
    if (has(doc, '<w:object')) out.push('embedded objects');
  } else if (under('xl/')) {
    const book = await text('xl/workbook.xml');
    const keaMade = book.includes('_kea_data');
    if (under('xl/pivotTables/')) out.push('pivot tables');
    if (!keaMade && under('xl/charts/')) out.push('charts');
    if (!keaMade && under('xl/media/')) out.push('pictures');
    if (under('xl/slicers/')) out.push('slicers');
  } else if (under('ppt/')) {
    if (under('ppt/charts/')) out.push('charts');
    if (under('ppt/diagrams/')) out.push('SmartArt');
    const slides = files.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    let tables = false;
    let anim = false;
    for (const f of slides) {
      const s = await text(f);
      if (s.includes('<a:tbl>')) tables = true;
      if (/<p:timing>[\s\S]*<p:par>/.test(s)) anim = true;
    }
    if (tables) out.push('tables');
    if (anim) out.push('animations');
    if (files.some((f) => /^ppt\/media\/.*\.(mp4|m4v|mov|wmv|avi|mp3|wav|m4a|wma)$/i.test(f))) out.push('video and sound');
  }
  if (/m$/.test(ext) && under(ext.startsWith('x') ? 'xl/vbaProject' : ext.startsWith('d') ? 'word/vbaProject' : 'ppt/vbaProject')) out.push('macros');
  return out;
}

export const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);


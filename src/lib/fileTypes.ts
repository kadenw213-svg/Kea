export type EditorKind = 'pdf' | 'doc' | 'sheet' | 'code' | 'image' | 'unsupported';

const EXT_KIND: Record<string, EditorKind> = {
  pdf: 'pdf',
  docx: 'doc', html: 'doc', htm: 'doc', rtf: 'unsupported', doc: 'unsupported', odt: 'unsupported',
  xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', ods: 'sheet', csv: 'sheet', tsv: 'sheet',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', ico: 'image',
  pptx: 'unsupported', ppt: 'unsupported', odp: 'unsupported',
  zip: 'unsupported', exe: 'unsupported', dll: 'unsupported', mp3: 'unsupported', mp4: 'unsupported'
};

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function baseName(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

/** Sniff bytes so mislabelled files still open in the right editor. */
export function kindFor(name: string, data?: Uint8Array): EditorKind {
  const ext = extOf(name);
  if (data && data.length > 4) {
    if (data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) return 'pdf';
  }
  if (EXT_KIND[ext]) return EXT_KIND[ext];
  if (data && looksBinary(data)) return 'unsupported';
  return 'code';
}

function looksBinary(data: Uint8Array): boolean {
  const n = Math.min(data.length, 8000);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}

export const OPEN_FILTERS = [
  {
    name: 'All supported',
    extensions: ['pdf', 'docx', 'html', 'htm', 'xlsx', 'xlsm', 'xls', 'ods', 'csv', 'tsv', 'txt', 'md', 'json', 'js', 'ts', 'tsx', 'jsx', 'py', 'css', 'xml', 'yaml', 'yml', 'ini', 'log', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
  },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'Documents', extensions: ['docx', 'html', 'htm'] },
  { name: 'Spreadsheets', extensions: ['xlsx', 'xlsm', 'xls', 'ods', 'csv', 'tsv'] },
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] },
  { name: 'All files', extensions: ['*'] }
];

export const UNSUPPORTED_HINT: Record<string, string> = {
  doc: 'Old .doc files use a closed binary format. Open it in Word or LibreOffice once and save as .docx, then it will open here.',
  rtf: 'RTF is not supported yet. Save it as .docx to edit it here.',
  odt: 'OpenDocument text is not supported yet. Save it as .docx to edit it here.',
  pptx: 'Presentations are coming in a later version of Slate.',
  ppt: 'Presentations are coming in a later version of Slate.',
  odp: 'Presentations are coming in a later version of Slate.'
};

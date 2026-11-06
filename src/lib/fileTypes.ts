export type EditorKind = 'pdf' | 'doc' | 'sheet' | 'slides' | 'code' | 'image' | 'video' | 'unsupported';

const EXT_KIND: Record<string, EditorKind> = {
  pdf: 'pdf',
  docx: 'doc', docm: 'doc', dotx: 'doc', html: 'doc', htm: 'doc', rtf: 'doc', doc: 'doc', odt: 'doc',
  // Markdown opens as a document (formatting shown, saved back as Markdown).
  md: 'doc', markdown: 'doc',
  xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', ods: 'sheet', csv: 'sheet', tsv: 'sheet',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', ico: 'image', psd: 'image',
  pptx: 'slides', pptm: 'slides', potx: 'slides', ppsx: 'slides', ppt: 'unsupported', odp: 'unsupported',
  // Video projects, and video and audio files (each opens as a new project with the file on its timeline).
  keavideo: 'video', mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', mkv: 'video',
  mp3: 'video', wav: 'video', m4a: 'video', aac: 'video', ogg: 'video', oga: 'video', opus: 'video', flac: 'video',
  zip: 'unsupported', exe: 'unsupported', dll: 'unsupported'
};

/** Video and audio files are streamed from disk by the video editor, never read into memory whole. */
export const STREAMED_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac'];

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
    extensions: ['pdf', 'docx', 'doc', 'odt', 'rtf', 'pptx', 'ppsx', 'html', 'htm', 'xlsx', 'xlsm', 'xls', 'ods', 'csv', 'tsv', 'txt', 'md', 'json', 'js', 'ts', 'tsx', 'jsx', 'py', 'css', 'xml', 'yaml', 'yml', 'ini', 'log', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'psd', 'keavideo', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac']
  },
  { name: 'PDF', extensions: ['pdf'] },
  { name: 'Documents', extensions: ['docx', 'doc', 'odt', 'rtf', 'html', 'htm'] },
  { name: 'Presentations', extensions: ['pptx', 'ppsx', 'potx'] },
  { name: 'Spreadsheets', extensions: ['xlsx', 'xlsm', 'xls', 'ods', 'csv', 'tsv'] },
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'psd'] },
  { name: 'Video and audio', extensions: ['keavideo', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac'] },
  { name: 'All files', extensions: ['*'] }
];

export const UNSUPPORTED_HINT: Record<string, string> = {
  ppt: 'Old .ppt presentations use a closed binary format. Open it in PowerPoint or LibreOffice once and save as .pptx, then it will open here.',
  odp: 'OpenDocument presentations are not supported yet. Save it as .pptx in LibreOffice to open it here.'
};

import { FileText, Sheet, FileCode2, Image as ImageIcon, File, FileType2, Presentation } from 'lucide-react';
import { kindFor } from '../lib/fileTypes';

export const KIND_COLORS: Record<string, string> = {
  pdf: '#f28b82',
  doc: '#8ab4f8',
  sheet: '#81c995',
  slides: '#fcad70',
  image: '#fdd663',
  code: '#c58af9',
  unsupported: '#9aa0a6'
};

export function FileIcon({ name, kind, size = 18 }: { name?: string; kind?: string; size?: number }) {
  const k = kind || kindFor(name || '');
  const color = KIND_COLORS[k] || KIND_COLORS.unsupported;
  const props = { size, color, strokeWidth: 1.8 };
  switch (k) {
    case 'pdf':
      return <FileType2 {...props} />;
    case 'doc':
      return <FileText {...props} />;
    case 'sheet':
      return <Sheet {...props} />;
    case 'slides':
      return <Presentation {...props} />;
    case 'image':
      return <ImageIcon {...props} />;
    case 'code':
      return <FileCode2 {...props} />;
    default:
      return <File {...props} />;
  }
}

export interface FileEntry {
  path: string;
  name: string;
  data: Uint8Array;
  size?: number;
}
export interface RecentEntry {
  path: string;
  name: string;
  openedAt: number;
}
export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface SlateApi {
  platform: string;
  openDialog(opts?: { title?: string; multi?: boolean; filters?: FileFilter[] }): Promise<FileEntry[]>;
  saveDialog(opts?: { title?: string; defaultPath?: string; filters?: FileFilter[] }): Promise<string | null>;
  readFile(p: string): Promise<FileEntry>;
  writeFile(p: string, data: Uint8Array): Promise<boolean>;
  fileExists(p: string): Promise<boolean>;
  showInFolder(p: string): Promise<void>;
  getRecent(): Promise<RecentEntry[]>;
  addRecent(p: string): Promise<RecentEntry[]>;
  removeRecent(p: string): Promise<RecentEntry[]>;
  clearRecent(): Promise<RecentEntry[]>;
  printHtml(html: string): Promise<boolean>;
  pdfFromHtml(html: string, opts?: { pageSize?: string }): Promise<Uint8Array>;
  getPendingOpen(): Promise<string[]>;
  getPathForFile(file: File): string;
  onOpenPaths(cb: (paths: string[]) => void): () => void;
  onBeforeClose(cb: () => void): () => void;
  confirmClose(): void;
  getVersion(): Promise<string>;
  checkForUpdates(): Promise<{ status: string; message?: string }>;
  downloadUpdate(): Promise<boolean>;
  installUpdate(): void;
  onUpdateState(cb: (s: UpdateState) => void): () => void;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'latest' | 'downloading' | 'ready' | 'error' | 'dev';
  version?: string;
  percent?: number;
  message?: string;
  notes?: string;
}

declare global {
  interface Window {
    api: SlateApi;
  }
}

export const api: SlateApi = window.api;

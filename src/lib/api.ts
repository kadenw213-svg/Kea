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
  ai: AiApi;
}

export type AiTier = 'light' | 'balanced' | 'best';
export interface AiSettings {
  slider: number;
  tier: AiTier;
  contextSize: number;
  maxTokens: number;
  gpu: boolean;
  gpuLayers: 'auto' | number;
  threads: number;
  temperature: number;
  keepLoaded: boolean;
  custom: boolean;
}
export interface AiModelState {
  tier: AiTier;
  label: string;
  model: string;
  license: string;
  size: number;
  minRam: number;
  blurb: string;
  installed: boolean;
  download: { status: 'downloading' | 'paused' | 'verifying' | 'done' | 'error'; received: number; total: number; error?: string } | null;
}
export interface AiHardware {
  gpu: string | false;
  gpuNames: string[];
  vramTotal: number;
  vramFree: number;
  unified: boolean;
  ramTotal: number;
  ramFree: number;
  cpuThreads: number;
  cpuName: string;
}
export interface AiState {
  hardware: AiHardware;
  settings: AiSettings;
  recommended: { slider: number; tier: AiTier; contextSize: number; maxTokens: number };
  presets: { tier: AiTier; contextSize: number; maxTokens: number }[];
  models: AiModelState[];
}
export interface AiGenerateRequest {
  system?: string;
  history?: { role: 'user' | 'assistant'; text: string }[];
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  jsonSchema?: any;
}
export type AiEvent =
  | { type: 'token'; id: string; text: string }
  | { type: 'done'; id: string; text: string; tokensPerSecond?: number; aborted?: boolean }
  | { type: 'error'; id: string; message: string };
export interface AiApi {
  state(): Promise<AiState>;
  setSettings(patch: Partial<AiSettings>): Promise<AiSettings>;
  resetSettings(): Promise<AiSettings>;
  download(tier: AiTier): Promise<boolean>;
  pauseDownload(tier: AiTier): Promise<boolean>;
  deleteModel(tier: AiTier): Promise<boolean>;
  generate(req: AiGenerateRequest): Promise<string>;
  stop(id: string): Promise<boolean>;
  count(text: string): Promise<number>;
  benchmark(): Promise<{ loadMs: number; tokensPerSecond: number }>;
  onEvent(cb: (e: AiEvent) => void): () => void;
  onDownload(cb: (m: AiModelState) => void): () => void;
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

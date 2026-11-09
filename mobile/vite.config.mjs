// Kea for Android: a small app of its own, built into mobile/dist for Capacitor. It shares Kea on the PC's study screens
// and reader (src/components/scholar) and its study code (electron/scholar/study.cjs, studyMerge.cjs), which run here
// over the phone's copy of the data: Node's fs, path and crypto, and Kea's profile and class-database modules, are
// replaced by small stand-ins (mobile/src/node).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

/** pdf.js's fonts and character maps (the reader needs them for some PDFs), from Kea on the PC's public folder. */
const pdfAssets = () => ({
  name: 'kea-pdfjs-assets',
  closeBundle() {
    const from = here('../public/pdfjs');
    if (fs.existsSync(from)) fs.cpSync(from, path.join(here('./dist'), 'pdfjs'), { recursive: true });
  }
});

// The built-in sign-in clients (VITE_KEA_GOOGLE_CLIENT_ID, VITE_KEA_MICROSOFT_CLIENT_ID), from the owner's file outside
// the repo (scripts/oauth-clients.cjs). Ones already in the environment win; without either, sign-in isn't available
// in this build and the phone says so.
{
  const require = createRequire(import.meta.url);
  const { readOwnerFile, mobileEnv } = require('../scripts/oauth-clients.cjs');
  const { config, warning } = readOwnerFile();
  for (const [k, v] of Object.entries(mobileEnv(config))) if (!process.env[k]) process.env[k] = v;
  if (!process.env.VITE_KEA_GOOGLE_CLIENT_ID && !process.env.VITE_KEA_MICROSOFT_CLIENT_ID && !process.env.KEA_OAUTH_CHECKED) console.warn(`Warning: ${warning || 'no built-in sign-in client for the phone app'}`);
}

export default defineConfig({
  root: here('.'),
  base: './',
  publicDir: false,
  plugins: [react(), pdfAssets()],
  resolve: {
    alias: [
      { find: /^fs$/, replacement: here('./src/node/fs.ts') },
      { find: /^path$/, replacement: here('./src/node/path.ts') },
      { find: /^crypto$/, replacement: here('./src/node/crypto.ts') },
      { find: /^\.\/profiles\.cjs$/, replacement: here('./src/node/profiles.ts') },
      { find: /^\.\/db\.cjs$/, replacement: here('./src/node/db.ts') },
      { find: /^\.\/(browser|runner|precheck|workspace)\.cjs$/, replacement: here('./src/node/stub.ts') }
    ]
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    // Kea on the PC's CommonJS modules, bundled as they are.
    commonjsOptions: { include: [/node_modules/, /electron[\\/]scholar[\\/].*\.cjs$/, /electron[\\/]wikiCore\.cjs$/],transformMixedEsModules: true }
  }
});

// Kea for Android: a small app of its own (not the desktop app), built into mobile/dist for Capacitor.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2020' }
});

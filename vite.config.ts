import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The UI lives in /src and imports the pure engine from /engine directly (Vite
// resolves the engine's `.js` specifiers to their `.ts` sources, same as vitest).
// No engine code is touched — the app is a consumer of the engine's public API.
export default defineConfig({
  root: '.',
  plugins: [react()],
  server: { port: 5173, open: false },
  build: { outDir: 'dist' },
});

import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The UI lives in /src and imports the pure engine from /engine directly (Vite
// resolves the engine's `.js` specifiers to their `.ts` sources, same as vitest).
// No engine code is touched — the app is a consumer of the engine's public API.
export default defineConfig({
  root: '.',
  plugins: [react()],
  server: { port: 5173, open: false, watch: { ignored: ['**/sites/**'] } },
  build: { outDir: 'dist' },
  test: { exclude: [...configDefaults.exclude, 'sites/**'] },
});

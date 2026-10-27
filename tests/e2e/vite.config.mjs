import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
// Builds the REAL app (../../src, ../../index.html) with the firebase packages swapped for the
// in-memory stand-ins above. It never contains the real Firebase config or connects to Firebase.
export default defineConfig({
  root: path.join(here, '../..'),
  logLevel: 'warn',
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true },
  resolve: {
    alias: [
      { find: /^firebase\/firestore$/, replacement: path.join(here, 'firestoreBrowser.js') },
      { find: /^firebase\/auth$/, replacement: path.join(here, 'authFake.js') },
      { find: /^firebase\/app$/, replacement: path.join(here, 'appFake.js') },
    ],
  },
});

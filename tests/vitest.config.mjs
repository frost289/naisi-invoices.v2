import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Unit tests run the REAL files in ../src against an in-memory stand-in for
// Firestore (tests/helpers/fakeFirestore.js). These are mock tests: they do
// not exercise the real Firebase SDK, network, or security rules. See
// tests/README.md for what they do and do not prove.
export default defineConfig({
  root: here,
  // esbuild:false + threads/1 worker: no helper processes are spawned (some locked-down Windows setups refuse them); the sources are plain JavaScript.
  esbuild: false,
  test: { include: ['unit/**/*.test.js'], pool: 'threads', maxWorkers: 1, minWorkers: 1, fileParallelism: false },
  resolve: {
    alias: [
      { find: 'firebase/firestore', replacement: path.join(here, 'helpers/fakeFirestore.js') },
      { find: path.join(here, '../src/firebase.js'), replacement: path.join(here, 'helpers/fakeFirebaseApp.js') },
    ],
  },
  server: { fs: { allow: [path.join(here, '..')] } },
});

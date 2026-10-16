import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const helper = (f) => path.join(here, 'helpers', f);
// ONE copy of the Firebase SDK for everything in the rules tests.
// The app's src/ files, the test file and @firebase/rules-unit-testing must share the same Firebase SDK build, otherwise
// doc()/collection() reject the Firestore object ("Expected first argument to doc() ... invalid-argument") before any rule runs.
// Both imports are therefore routed to the CommonJS builds in tests/node_modules (see helpers/*-cjs.mjs). This changes
// NO security expectation and bypasses NO rule: the real SDK talks to the real emulator running the real rules file.
// esbuild:false + threads/1 worker avoid spawning helper processes (some locked-down Windows setups refuse them); the sources are plain JavaScript.
export default defineConfig({
  root: here,
  esbuild: false,
  resolve: {
    alias: [
      { find: /^firebase\/firestore$/, replacement: helper('firestore-cjs.mjs') },
      { find: /^@firebase\/rules-unit-testing$/, replacement: helper('rules-unit-testing-cjs.mjs') },
    ],
  },
  test: { include: ['rules/**/*.test.js'], testTimeout: 30000, hookTimeout: 30000, pool: 'threads', maxWorkers: 1, minWorkers: 1, fileParallelism: false },
});

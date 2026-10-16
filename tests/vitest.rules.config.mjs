import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
// Emulator tests use the real Firebase SDK against the Firestore emulator.
// The app's src/ files and the test helpers must share ONE copy of the SDK (a Firestore object from one copy is
// rejected by the other), so every 'firebase/...' import is pointed at tests/node_modules/firebase.
export default defineConfig({
  root: here,
  resolve: { alias: [{ find: /^firebase\/(.*)$/, replacement: path.join(here, 'node_modules/firebase/$1') }] },
  test: { include: ['rules/**/*.test.js'], testTimeout: 30000, hookTimeout: 30000 },
});

import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
// Emulator tests: NO aliasing - these use the real Firebase SDK against the Firestore emulator.
export default defineConfig({ root: here, test: { include: ['rules/**/*.test.js'], testTimeout: 30000, hookTimeout: 30000 } });

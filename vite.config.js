import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
// The visible build identifier. Single source: public/build-id.txt (also copied into dist/build-id.txt so a deployed site can be checked with a plain URL).
const BUILD_ID = readFileSync(new URL('./public/build-id.txt', import.meta.url), 'utf8').trim();
export default defineConfig({ define: { __BUILD_ID__: JSON.stringify(BUILD_ID) } });

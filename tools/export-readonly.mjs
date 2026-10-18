#!/usr/bin/env node
// GET only. Credentials are read from FIRESTORE_ACCESS_TOKEN, never persisted or
// logged. Default target is a local emulator. Remote access requires two explicit
// confirmations and is never used by this release's tests or packaging workflow.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EXPORT_TARGETS, sha256, parseArgs } from './export-manifest.mjs';

function decode(value) {
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) { const number = Number(value.integerValue); if (!Number.isSafeInteger(number)) throw new Error('An integer is outside the safe JSON-number range.'); return number; }
  if ('doubleValue' in value) { if (!Number.isFinite(value.doubleValue)) throw new Error('A non-finite numeric value cannot be exported safely.'); return value.doubleValue; }
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) {
    const ms = Date.parse(value.timestampValue); if (!Number.isFinite(ms)) throw new Error('Invalid Firestore timestamp.');
    const fraction = /\.(\d+)/.exec(value.timestampValue)?.[1] || '';
    return { seconds: Math.floor(ms / 1000), nanoseconds: Number(fraction.padEnd(9, '0').slice(0, 9)) };
  }
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, v]) => [key, decode(v)]));
  if ('referenceValue' in value) return value.referenceValue;
  if ('geoPointValue' in value) return value.geoPointValue;
  if ('bytesValue' in value) return value.bytesValue;
  throw new Error('Unsupported or malformed Firestore field value.');
}

let options;
try {
  const parsed = parseArgs(process.argv.slice(2), ['--project', '--host', '--out', '--confirm-project'], ['--allow-remote']);
  options = parsed.options;
  if (parsed.positional.length || !options['--project'] || !options['--out']) throw new Error('Usage: node tools/export-readonly.mjs --project <id> --out <empty directory> [--host http://127.0.0.1:8080] [--allow-remote --confirm-project <same id>].');
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(options['--project'])) throw new Error('--project must be a valid project id.');
  const hostValue = options['--host'] || (process.env.FIRESTORE_EMULATOR_HOST ? `http://${process.env.FIRESTORE_EMULATOR_HOST}` : 'http://127.0.0.1:8080');
  const url = new URL(hostValue.includes('://') ? hostValue : `http://${hostValue}`);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('--host must contain only the HTTP origin, without credentials or a path.');
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!local && (!options['--allow-remote'] || options['--confirm-project'] !== options['--project'])) throw new Error('Remote reads require --allow-remote together with --confirm-project matching --project.');
  if (!local && (url.protocol !== 'https:' || url.hostname !== 'firestore.googleapis.com')) throw new Error('Remote export permits only https://firestore.googleapis.com.');
  if (!local && !process.env.FIRESTORE_ACCESS_TOKEN) throw new Error('Set FIRESTORE_ACCESS_TOKEN in the environment for an authorised read-only remote export.');
  options.origin = url.origin;
  options.directory = resolve(options['--out']);
  mkdirSync(options.directory, { recursive: true });
  if (readdirSync(options.directory).length) throw new Error('--out must be an empty directory to avoid mixing exports.');
} catch (error) { console.error(error.message); process.exit(2); }

const startedAt = new Date().toISOString();
const projectId = options['--project'];
const base = `${options.origin}/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/`;
const headers = process.env.FIRESTORE_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.FIRESTORE_ACCESS_TOKEN}` } : {};
const collections = {};
let activeTarget = '';
try {
  for (const target of EXPORT_TARGETS) {
    activeTarget = target.key;
    const docs = [], ids = new Set(), tokens = new Set(); let token = '', pages = 0;
    do {
      if (++pages > 50000) throw new Error('Pagination safety limit exceeded.');
      const url = new URL(base + target.path);
      if (!target.singleton) { url.searchParams.set('pageSize', '300'); if (token) url.searchParams.set('pageToken', token); }
      // redirect:error prevents an origin change from receiving the access token.
      const response = await fetch(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (target.singleton && response.status === 404) break;
      if (!response.ok) throw new Error(`HTTP ${response.status}; export aborted.`);
      let page;
      try { page = await response.json(); } catch { throw new Error('Invalid or truncated JSON response.'); }
      if (!page || typeof page !== 'object' || Array.isArray(page) || page.error) throw new Error('Malformed Firestore response.');
      if (!target.singleton && page.documents !== undefined && !Array.isArray(page.documents)) throw new Error('Malformed documents page.');
      const batch = target.singleton ? [page] : (page.documents || []);
      for (const doc of batch) {
        const expected = `projects/${projectId}/databases/(default)/documents/${target.path}${target.singleton ? '' : '/'}`;
        if (typeof doc.name !== 'string' || (target.singleton ? doc.name !== expected : (!doc.name.startsWith(expected) || doc.name.slice(expected.length).includes('/')))) throw new Error('Document path does not match the requested project and collection.');
        const id = doc.name.split('/').pop();
        if (!id || ids.has(id)) throw new Error('Duplicate document across pages; export may be inconsistent or truncated.');
        ids.add(id);
        const fields = Object.fromEntries(Object.entries(doc.fields || {}).map(([key, v]) => [key, decode(v)]));
        if (Object.hasOwn(fields, 'id') && fields.id !== id) throw new Error('Stored id field disagrees with the document id.');
        docs.push({ ...fields, id });
      }
      if (page.nextPageToken !== undefined && typeof page.nextPageToken !== 'string') throw new Error('Malformed next-page token.');
      token = target.singleton ? '' : (page.nextPageToken || '');
      if (token && tokens.has(token)) throw new Error('Repeated pagination token; export is incomplete.');
      if (token && !batch.length) throw new Error('Empty page with a continuation token; export is incomplete.');
      if (token) tokens.add(token);
    } while (token);
    const raw = JSON.stringify(docs, null, 2) + '\n';
    writeFileSync(resolve(options.directory, target.file), raw, { flag: 'wx' });
    collections[target.key] = { file: target.file, source: target.path, count: docs.length, sha256: sha256(raw), complete: true };
  }
  const endedAt = new Date().toISOString();
  writeFileSync(resolve(options.directory, 'manifest.json'), JSON.stringify({ version: 1, complete: true, projectId, startedAt, endedAt, collections }, null, 2) + '\n', { flag: 'wx' });
  console.log(`COMPLETE: ${EXPORT_TARGETS.length} verified-format files exported for project ${projectId}. Manifest: ${resolve(options.directory, 'manifest.json')}`);
  console.log('GET-only export. The caller must freeze writes: REST pagination does not provide an atomic cross-collection snapshot. A manifest detects changed/missing files, not server-side omissions or an unverified freeze.');
} catch (error) {
  // Never emit response bodies, request headers, or fetch exceptions that could
  // echo credentials. Partial files deliberately have no complete manifest.
  const safe = /^(HTTP \d+; export aborted\.|Pagination|Invalid or truncated JSON|Malformed|Document path|Duplicate document|Stored id|Repeated pagination|Empty page|Unsupported|An integer|A non-finite|Invalid Firestore)/.test(error.message) ? error.message : 'Network, decoding, or file operation failed.';
  console.error(`INCOMPLETE: ${activeTarget}: ${safe} No complete manifest was written; do not use partial files.`);
  process.exit(3);
}

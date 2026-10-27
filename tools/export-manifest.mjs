// Shared, local-file-only integrity checks. A manifest proves the files match this
// export, not that the server was frozen or that the server returned a snapshot.
import { readFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';

export const EXPORT_TARGETS = [
  { key: 'orders', path: 'orders' },
  { key: 'invoices', path: 'invoices' },
  { key: 'invoiceNumbers', path: 'invoiceNumbers' },
  { key: 'orderCancellations', path: 'orderCancellations' },
  { key: 'stockMovements', path: 'stockMovements' },
  { key: 'customers', path: 'customers' },
  { key: 'products', path: 'products' },
  { key: 'scheduleChanges', path: 'scheduleChanges' },
  { key: 'counter', path: 'counters/naisiInvoice', singleton: true },
  { key: 'scheduleHistory', path: 'config/scheduleHistory', singleton: true },
].map(target => ({ ...target, file: `${target.key}.json` }));

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const explicitTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value.slice(0, 10) + 'T00:00:00Z')).toISOString().slice(0, 10) === value.slice(0, 10);

export function verifyManifest(path, { selectedFiles = {} } = {}) {
  const errors = [], data = {}; let manifest;
  try { manifest = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return { ok: false, errors: ['manifest.json is missing, unreadable, or invalid JSON.'], data, manifest: null }; }
  if (manifest?.version !== 1 || manifest.complete !== true) errors.push('Manifest is not a complete version 1 export.');
  if (typeof manifest?.projectId !== 'string' || !manifest.projectId) errors.push('Manifest projectId is missing.');
  if (!explicitTime(manifest?.startedAt) || !explicitTime(manifest?.endedAt) || Date.parse(manifest.endedAt) < Date.parse(manifest.startedAt)) errors.push('Manifest start/end times must be ordered ISO times with explicit offsets.');
  for (const target of EXPORT_TARGETS) {
    const entry = manifest?.collections?.[target.key];
    if (!entry || entry.file !== target.file || basename(entry.file) !== entry.file || entry.complete !== true || !Number.isSafeInteger(entry.count) || entry.count < 0 || !/^[a-f0-9]{64}$/i.test(entry.sha256 || '')) {
      errors.push(`${target.key}: missing or invalid complete count/hash/file entry.`); continue;
    }
    const file = resolve(dirname(path), entry.file);
    const normalPath = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
    if (selectedFiles[target.key] && normalPath(selectedFiles[target.key]) !== normalPath(file)) errors.push(`${target.key}: supplied file differs from the file verified by the manifest.`);
    let raw, docs;
    try { raw = readFileSync(file); docs = JSON.parse(raw.toString('utf8')); }
    catch { errors.push(`${target.key}: required file ${entry.file} is missing, unreadable, or invalid JSON.`); continue; }
    if (sha256(raw) !== entry.sha256.toLowerCase()) errors.push(`${target.key}: SHA-256 hash mismatch.`);
    if (!Array.isArray(docs)) { errors.push(`${target.key}: export must be a JSON array.`); continue; }
    if (docs.length !== entry.count) errors.push(`${target.key}: document count mismatch (${docs.length} versus ${entry.count}).`);
    const ids = docs.map(doc => doc?.id);
    if (ids.some(id => typeof id !== 'string' || !id.trim() || id.includes('/')) || new Set(ids).size !== ids.length) errors.push(`${target.key}: document ids are missing or duplicated.`);
    if (target.singleton && (docs.length > 1 || (docs.length === 1 && docs[0]?.id !== target.path.split('/').pop()))) errors.push(`${target.key}: invalid singleton document export.`);
    data[target.key] = docs;
  }
  return { ok: errors.length === 0, errors, manifest, data };
}

// Values are always explicit; a dangling option is a usage error, never a skipped input.
export function parseArgs(args, valueOptions, booleanOptions = []) {
  const options = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (booleanOptions.includes(arg)) { if (Object.hasOwn(options, arg)) throw new Error(`Duplicate option ${arg}.`); options[arg] = true; }
    else if (valueOptions.includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (Object.hasOwn(options, arg)) throw new Error(`Duplicate option ${arg}.`);
      options[arg] = args[++i];
    } else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}.`);
    else positional.push(arg);
  }
  return { options, positional };
}

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`Cannot read valid JSON from ${path}.`); }
}

export const singletonValue = value => Array.isArray(value) ? (value[0] || null) : value;

// Bulk "planned days" import (manager tool). PURE: parsing, name matching and planning only; nothing here writes.
// The manager uploads a spreadsheet (name + planned day, optional phone/area). Every row is matched to an existing customer
// and shown for review. Only rows the manager accepts are applied, one shop at a time, through the normal dated schedule change
// (see scheduleSuggest.applySuggestions). A row is NEVER guessed: unclear matches are shown as choices, missing shops are listed.
import { DEFAULT_DAYS } from './scheduleSuggest.js';

const DAY_WORDS = { mon: 'Mon', monday: 'Mon', tue: 'Tue', tues: 'Tue', tuesday: 'Tue', wed: 'Wed', wednesday: 'Wed', thu: 'Thu', thur: 'Thu', thurs: 'Thu', thursday: 'Thu', fri: 'Fri', friday: 'Fri', sat: 'Sat', saturday: 'Sat' };
export function parseDay(v) {
  const k = String(v ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
  return DAY_WORDS[k] || null;
}
const STOP = new Set(['shop', 'shops', 'investment', 'investments', 'stores', 'store', 'trading', 'traders', 'enterprise', 'enterprises', 'general', 'dealers', 'and', 'the', 'ya', 'ndi', 'mini', 'market', 'supermarket', 'wholesale', 'retail', 'superstore', 'groceries', 'grocery']);
const SUFFIXES = ['shop', 'shops', 'investment', 'investments', 'stores', 'store', 'trading', 'traders', 'supermarket', 'wholesale', 'superstore'];
// "6 To 7shop" and "6 To 7 Shop" must give the same key
export function nameKey(name) {
  const words = String(name ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  let k = words.filter(w => !STOP.has(w)).join('');
  if (!k) k = words.join('');
  for (let changed = true; changed;) {
    changed = false;
    for (const s of SUFFIXES) if (k.length > s.length + 2 && k.endsWith(s)) { k = k.slice(0, -s.length); changed = true; }
  }
  return k;
}
export const phoneKey = (p) => { const d = String(p ?? '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };
// bigram similarity 0..1 (deterministic, no dependencies)
export function similarity(a, b) {
  if (a === b) return 1; if (a.length < 2 || b.length < 2) return 0;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const A = grams(a), B = grams(b); let hit = 0;
  for (const [g, n] of A) hit += Math.min(n, B.get(g) || 0);
  return (2 * hit) / ((a.length - 1) + (b.length - 1));
}

// ---- reading the spreadsheet ----
const HEAD = { name: ['name', 'customer', 'customername', 'shop', 'shopname', 'plannameshop', 'planname'], day: ['day', 'plannedday', 'visitday', 'weekday', 'assignedday'], phone: ['phone', 'telephone', 'mobile', 'planphone'], area: ['area', 'tradingarea', 'location', 'plantradingarea'], type: ['type', 'kind'] };
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
export function readTable(rows2d) {
  const head = (rows2d[0] || []).map(norm);
  const col = {};
  for (const [field, names] of Object.entries(HEAD)) { const i = head.findIndex(h => names.includes(h)); if (i >= 0) col[field] = i; }
  if (col.name === undefined || col.day === undefined) throw new Error('The sheet needs a "Name" column and a "Day" column (Mon-Sat) in the first row.');
  const out = [];
  rows2d.slice(1).forEach((r, i) => {
    const name = String(r[col.name] ?? '').trim();
    if (!name) return;
    out.push({ line: i + 2, name, dayRaw: String(r[col.day] ?? '').trim(), phone: col.phone !== undefined ? String(r[col.phone] ?? '').trim() : '', area: col.area !== undefined ? String(r[col.area] ?? '').trim() : '',
      type: col.type !== undefined ? String(r[col.type] ?? '').trim().toLowerCase() : '' });
  });
  return out;
}
export function parseCsv(text) {
  const t = String(text ?? '').replace(/^﻿/, ''); const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(x => x !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some(x => x !== '')) rows.push(row);
  return rows;
}

// An ExcelJS worksheet -> array of arrays of plain text/numbers (formulas use their result, rich text its plain text, links their text).
export function rowsFromWorksheet(ws) {
  const plain = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if ('result' in v) return plain(v.result);
      if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
      if ('text' in v) return plain(v.text);
      return '';
    }
    return v;
  };
  const out = [];
  ws.eachRow({ includeEmpty: false }, (row) => { out.push(row.values.slice(1).map(plain)); });
  return out;
}

// ---- matching ----
// status: matched | choose (several or similar candidates: the manager picks) | missing | skip (not a customer / bad day / unusable)
export function planImport(planRows, customers, { similar = 0.85 } = {}) {
  const usable = customers.filter(c => c && c.id);
  const index = usable.map(c => ({ c, key: nameKey(c.name), ph: phoneKey(c.phone) }));
  const rows = planRows.map((p) => {
    const base = { line: p.line, planName: p.name, planPhone: p.phone, planArea: p.area, day: parseDay(p.dayRaw), dayRaw: p.dayRaw, candidates: [], customerId: null, how: '', status: 'missing', note: '' };
    if (/^(new-shop prospect|callback visit)/i.test(p.name) || ['prospect', 'callback'].includes(p.type)) return { ...base, status: 'skip', note: 'Not an existing customer (prospect or callback slot).' };
    if (!base.day) return { ...base, status: 'skip', note: `Day "${p.dayRaw}" is not Monday to Saturday.` };
    const k = nameKey(p.name), pk = phoneKey(p.phone);
    let hit = index.filter(x => x.key === k);
    if (hit.length > 1 && pk) { const byPhone = hit.filter(x => x.ph === pk); if (byPhone.length === 1) hit = byPhone; }
    if (hit.length === 1) return { ...base, status: 'matched', how: 'same name', customerId: hit[0].c.id, candidates: [hit[0].c.id] };
    if (hit.length > 1) return { ...base, status: 'choose', how: `${hit.length} customers with this name`, candidates: hit.map(x => x.c.id) };
    if (pk) { const byPhone = index.filter(x => x.ph === pk); if (byPhone.length === 1) return { ...base, status: 'matched', how: 'same phone number', customerId: byPhone[0].c.id, candidates: [byPhone[0].c.id] };
      if (byPhone.length > 1) return { ...base, status: 'choose', how: 'several customers share this phone', candidates: byPhone.map(x => x.c.id) }; }
    const near = index.map(x => ({ x, s: similarity(k, x.key) })).filter(r => r.s >= similar).sort((a, b) => b.s - a.s || (a.x.c.id < b.x.c.id ? -1 : 1)).slice(0, 3);
    if (near.length) return { ...base, status: 'choose', how: 'similar name, please confirm', candidates: near.map(r => r.x.c.id) };
    return { ...base, note: 'Not found in the app. Add it (with a map pin) first.' };
  });
  // the same customer planned on two different days = ambiguous plan: neither is applied
  const byCust = new Map();
  for (const r of rows) if (r.status === 'matched') (byCust.get(r.customerId) || byCust.set(r.customerId, []).get(r.customerId)).push(r);
  for (const list of byCust.values()) if (new Set(list.map(r => r.day)).size > 1) for (const r of list) { r.status = 'skip'; r.note = 'The plan gives this customer more than one day.'; }
  return rows;
}

// Turns reviewed rows into moves. choices: { [line]: customerId } for rows the manager resolved. Skips shops that cannot be scheduled.
export function buildMoves(rows, customers, choices = {}) {
  const byId = new Map(customers.map(c => [c.id, c]));
  const moves = [], notes = [];
  const seen = new Map();
  for (const r of rows) {
    const id = r.status === 'matched' ? r.customerId : (r.status === 'choose' ? choices[r.line] : null);
    if (!id) continue;
    const c = byId.get(id);
    if (!c) { notes.push({ line: r.line, name: r.planName, why: 'customer no longer exists' }); continue; }
    if (c.active === false) { notes.push({ line: r.line, name: c.name, why: 'customer is inactive: reactivate first' }); continue; }
    if (c.mergeLock) { notes.push({ line: r.line, name: c.name, why: 'customer is being merged' }); continue; }
    if (seen.has(id) && seen.get(id) !== r.day) { notes.push({ line: r.line, name: c.name, why: 'chosen for two different days' }); continue; }
    seen.set(id, r.day);
    const from = c.assignedDay || null;
    if (from === r.day) { notes.push({ line: r.line, name: c.name, why: 'already on ' + r.day, already: true }); continue; }
    if (moves.some(m => m.id === id)) continue;
    moves.push({ id, name: c.name, from, to: r.day, line: r.line });
  }
  return { moves, notes };
}
export { DEFAULT_DAYS };

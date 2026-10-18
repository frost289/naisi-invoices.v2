import { describe, it, expect, beforeEach } from 'vitest';
import { F } from './_util.js';
const I = await import('../../src/scheduleImport.js');
const S = await import('../../src/scheduleSuggest.js');
const cust = await import('../../src/customers.js');
const mgr = { uid: 'mgr1', email: 'mgr@naisi.test' };
const C = (id, name, extra = {}) => ({ id, name, phone: '', active: true, assignedDay: null, ...extra });
beforeEach(() => { F.reset(); F.setClock(Date.parse('2026-10-15T08:00:00Z')); });

describe('reading the sheet', () => {
  it('parses days in any common spelling and rejects Sunday / nonsense', () => {
    expect(['Mon', 'monday', 'TUES', ' Wednesday ', 'thur', 'Fri', 'saturday'].map(I.parseDay)).toEqual(['Mon', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    expect(I.parseDay('Sunday')).toBe(null); expect(I.parseDay('')).toBe(null); expect(I.parseDay('Tomorrow')).toBe(null);
  });
  it('reads a table with flexible headers and needs Name and Day columns', () => {
    const rows = I.readTable([['Customer', 'Planned day', 'Phone'], ['Alpha', 'Mon', '099'], ['', 'Tue', ''], ['Beta', 'Fri', '']]);
    expect(rows.map(r => [r.name, r.dayRaw, r.line])).toEqual([['Alpha', 'Mon', 2], ['Beta', 'Fri', 4]]);
    expect(() => I.readTable([['Shop', 'Phone'], ['x', '1']])).toThrow(/Name.*Day/);
  });
  it('reads CSV with quotes, commas, a BOM and Windows line endings', () => {
    const rows = I.parseCsv('﻿name,day\r\n"Shop, Big ""One""",Mon\r\nBeta,Tue\r\n');
    expect(rows).toEqual([['name', 'day'], ['Shop, Big "One"', 'Mon'], ['Beta', 'Tue']]);
  });
});

describe('matching names', () => {
  it('is tolerant of spacing and common words, and strict about different shops', () => {
    expect(I.nameKey('6 To 7 Shop')).toBe(I.nameKey('6 To 7shop'));
    expect(I.nameKey('Y B Investment')).toBe(I.nameKey('Y.B Investment'));
    expect(I.nameKey('Jozani')).not.toBe(I.nameKey('Jakapu Traders'));
    expect(I.phoneKey('+265 99 337 8232')).toBe('993378232'); expect(I.phoneKey('0999')).toBe('');
  });
  it('same name -> matched; several same-name -> choose; same phone -> matched; similar -> choose; unknown -> missing', () => {
    const customers = [C('a', 'Alpha Shop'), C('b1', 'Beta Stores'), C('b2', 'Beta Stores'), C('p', 'Phone Person', { phone: '+265999111222' }), C('s', 'Kalambo Bakery')];
    const rows = I.planImport([
      { line: 2, name: 'Alpha', dayRaw: 'Mon' }, { line: 3, name: 'Beta', dayRaw: 'Tue' }, { line: 4, name: 'Someone Else', phone: '0999 111 222', dayRaw: 'Wed' },
      { line: 5, name: 'Kalambo Bakry', dayRaw: 'Thu' }, { line: 6, name: 'Zebra Mart', dayRaw: 'Fri' }], customers);
    expect(rows.map(r => r.status)).toEqual(['matched', 'choose', 'matched', 'choose', 'missing']);
    expect(rows[1].candidates).toEqual(['b1', 'b2']); expect(rows[2].how).toBe('same phone number');
  });
  it('a phone number settles several same-name customers', () => {
    const rows = I.planImport([{ line: 2, name: 'Beta', phone: '0999000222', dayRaw: 'Mon' }], [C('b1', 'Beta', { phone: '0999000111' }), C('b2', 'Beta', { phone: '0999000222' })]);
    expect(rows[0]).toMatchObject({ status: 'matched', customerId: 'b2' });
  });
  it('prospect and callback slots, Sunday and unknown days are skipped with a reason; one customer on two days blocks both rows', () => {
    const rows = I.planImport([{ line: 2, name: 'New-shop prospect - X', dayRaw: 'Mon' }, { line: 3, name: 'Alpha', dayRaw: 'Sunday' }, { line: 4, name: 'Callback visit', dayRaw: 'Sat' },
      { line: 5, name: 'Alpha', dayRaw: 'Mon' }, { line: 6, name: 'Alpha Shop', dayRaw: 'Tue' }, { line: 7, name: 'x', dayRaw: 'Mon', type: 'prospect' }], [C('a', 'Alpha Shop')]);
    expect(rows.map(r => r.status)).toEqual(['skip', 'skip', 'skip', 'skip', 'skip', 'skip']);
    expect(rows[3].note).toMatch(/more than one day/);
  });
  it('does not modify its inputs', () => {
    const cs = [C('a', 'Alpha')], pr = [{ line: 2, name: 'Alpha', dayRaw: 'Mon' }]; const a = JSON.stringify([cs, pr]);
    I.planImport(pr, cs); expect(JSON.stringify([cs, pr])).toBe(a);
  });
});

describe('building the changes', () => {
  const customers = [C('a', 'Alpha', { assignedDay: 'Thu' }), C('b', 'Beta'), C('c', 'Gamma', { active: false }), C('d', 'Delta', { mergeLock: { into: 'a' } }), C('e', 'Echo', { assignedDay: 'Mon' }), C('f1', 'Fox'), C('f2', 'Fox')];
  it('moves matched shops, notes already-set / inactive / merging shops, and needs a choice for ambiguous rows', () => {
    const rows = I.planImport([{ line: 2, name: 'Alpha', dayRaw: 'Fri' }, { line: 3, name: 'Beta', dayRaw: 'Mon' }, { line: 4, name: 'Gamma', dayRaw: 'Tue' }, { line: 5, name: 'Delta', dayRaw: 'Tue' },
      { line: 6, name: 'Echo', dayRaw: 'Mon' }, { line: 7, name: 'Fox', dayRaw: 'Wed' }], customers);
    const none = I.buildMoves(rows, customers);
    expect(none.moves.map(m => [m.name, m.from, m.to])).toEqual([['Alpha', 'Thu', 'Fri'], ['Beta', null, 'Mon']]);
    expect(none.notes.map(n => n.why)).toEqual(['customer is inactive: reactivate first', 'customer is being merged', 'already on Mon']);
    const chosen = I.buildMoves(rows, customers, { 7: 'f2' });
    expect(chosen.moves.map(m => m.id)).toEqual(['a', 'b', 'f2']);
  });
});

describe('end to end with the guarded apply', () => {
  it('applies reviewed moves with one dated history entry each; a change made meanwhile is skipped', async () => {
    for (const c of [C('a', 'Alpha', { lat: -13.9, lng: 33.7 }), C('b', 'Beta', { lat: -13.9, lng: 33.7 })]) { const { id, ...d } = c; F.store.set('customers/' + id, d); }
    const customers = [C('a', 'Alpha'), C('b', 'Beta')];
    const rows = I.planImport([{ line: 2, name: 'Alpha', dayRaw: 'Mon' }, { line: 3, name: 'Beta', dayRaw: 'Tue' }], customers);
    const { moves } = I.buildMoves(rows, customers);
    F.store.set('customers/b', { name: 'Beta', phone: '', active: true, assignedDay: 'Sat', lat: -13.9, lng: 33.7 });   // someone else scheduled Beta meanwhile
    const r = await S.applySuggestions(moves, { setDay: (id, to, from) => cust.setCustomerVisitDay(id, to, { ...mgr, expectedDay: from }) });
    expect(r.applied.map(m => m.id)).toEqual(['a']); expect(r.stale.map(m => m.id)).toEqual(['b']);
    expect(F.store.get('customers/a').assignedDay).toBe('Mon'); expect(F.store.get('customers/b').assignedDay).toBe('Sat');
    expect([...F.store].filter(([p]) => p.startsWith('scheduleChanges/'))).toHaveLength(1);
  });
});

describe('reading a real .xlsx', () => {
  it('converts a worksheet (formulas, rich text, links) to plain rows and feeds the same pipeline', async () => {
    const ExcelJS = (await import('exceljs')).default; const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Plan');
    ws.addRow(['Name', 'Day', 'Phone']); ws.addRow(['Alpha Shop', 'Mon', '0999111222']);
    ws.addRow([{ richText: [{ text: 'Beta ' }, { text: 'Stores' }] }, { formula: '"Tu"&"e"', result: 'Tue' }, 99911]);
    ws.addRow([{ text: 'Gamma', hyperlink: 'http://x' }, 'Sat', '']);
    const buf = await wb.xlsx.writeBuffer(); const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(buf);
    const rows = I.readTable(I.rowsFromWorksheet(wb2.worksheets[0]));
    expect(rows.map(r => [r.name, r.dayRaw])).toEqual([['Alpha Shop', 'Mon'], ['Beta Stores', 'Tue'], ['Gamma', 'Sat']]);
    const plan = I.planImport(rows, [C('a', 'Alpha'), C('b', 'Beta'), C('g', 'Gamma')]);
    expect(plan.map(r => r.status)).toEqual(['matched', 'matched', 'matched']);
  });
});

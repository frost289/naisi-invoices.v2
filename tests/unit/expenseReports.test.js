import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/firebase.js', () => ({ db: {}, auth: {}, googleProvider: {} }));
import { validateLine, lineFields, summarizeLines, reportId, lineId } from '../../src/expenseReports.js';
import { claimCategoriesFor, CLAIM_CATEGORIES } from '../../src/expenseCategories.js';

const ok = { date: '2026-10-30', category: 'Transport', amount: '1500', notes: 'Minibus to Kanengo' };

describe('claim line validation', () => {
  it('accepts a complete line', () => { expect(validateLine(ok, 'rep')).toEqual([]); });
  it('needs a real date, a role category, a positive amount and a description', () => {
    expect(validateLine({ ...ok, date: '2026-02-30' }, 'rep').join()).toMatch(/date/);
    expect(validateLine({ ...ok, category: 'Fuel' }, 'deliverer').join()).toMatch(/category/);        // fuel is outside the float
    expect(validateLine({ ...ok, category: 'VehicleMaintenance' }, 'rep').join()).toMatch(/category/); // driver-only
    expect(validateLine({ ...ok, category: 'EmergencyCash' }, 'deliverer').join()).toMatch(/category/);
    expect(validateLine({ ...ok, amount: 0 }, 'rep').join()).toMatch(/greater than zero/);
    expect(validateLine({ ...ok, amount: 2e7 }, 'rep').join()).toMatch(/too large/);
    expect(validateLine({ ...ok, notes: '  ' }, 'rep').join()).toMatch(/what it was for/);
  });
  it('stores clean, rounded fields with the exact keys the rules allow', () => {
    expect(lineFields({ ...ok, amount: '1500.456', notes: ' x ' })).toEqual({
      date: '2026-10-30', category: 'Transport', subcategory: '', amount: 1500.46, notes: 'x', payee: '', receiptRef: '', vehicleId: null,
    });
  });
});

describe('report totals', () => {
  it('splits claimed into approved / rejected / pending', () => {
    const s = summarizeLines([
      { amount: 1000, lineStatus: 'approved' }, { amount: 250.5, lineStatus: 'rejected' }, { amount: 400, lineStatus: 'pending' },
    ]);
    expect(s).toEqual({ claimed: 1650.5, approved: 1000, rejected: 250.5, pending: 400, count: 3 });
  });
});

describe('claimable categories', () => {
  it('role set, narrowed by the manager list; empty list = whole role set; never Fuel', () => {
    expect(claimCategoriesFor('rep', []).map(c => c.value)).toEqual(CLAIM_CATEGORIES.rep);
    expect(claimCategoriesFor('rep', ['Transport', 'VehicleMaintenance']).map(c => c.value)).toEqual(['Transport']);
    expect(claimCategoriesFor('deliverer').map(c => c.value)).toEqual(['Transport', 'Meals', 'Other', 'VehicleMaintenance']);
    for (const r of ['rep', 'deliverer']) expect(CLAIM_CATEGORIES[r]).not.toContain('Fuel');
    expect(claimCategoriesFor('manager')).toEqual([]);
  });
});

describe('ids match the rules', () => {
  it('report and line ids', () => {
    expect(reportId('uidA', 'ab-cd')).toMatch(/^er_uidA_[A-Za-z0-9]{1,24}$/);
    expect(lineId('uidA', 'x'.repeat(40))).toBe('el_uidA_' + 'x'.repeat(24));
  });
});

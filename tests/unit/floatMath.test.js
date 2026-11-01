import { describe, it, expect } from 'vitest';
import {
  closingBalance, proposedTopUp, periodPosition, netIssued, requireIssueAmount, requireOpeningBalance,
  periodId, issueId, reversalId, newRequestId,
} from '../../src/floatMath.js';
import {
  expenseCategoriesFor, expenseCategoriesV2For, EXPENSE_CATEGORIES_V2, subcategoriesFor, categoryLabel,
} from '../../src/expenseCategories.js';

describe('float formula (design §4)', () => {
  it('closing = opening + issued − approved; top-up = max(0, target − closing)', () => {
    expect(closingBalance(2000, 5000, 3500)).toBe(3500);
    expect(proposedTopUp(20000, 3500)).toBe(16500);
    expect(proposedTopUp(20000, 25000)).toBe(0);
    expect(proposedTopUp(10000, -3000)).toBe(13000);   // a debt is recovered by the top-up
  });
  it('position of a period document', () => {
    expect(periodPosition({ openingBalance: 1000, totalIssued: 9000, totalApproved: 4000.5, floatTarget: 10000 }))
      .toEqual({ opening: 1000, issued: 9000, approved: 4000.5, balance: 5999.5, target: 10000, topUp: 4000.5 });
    expect(periodPosition(null)).toBeNull();
  });
  it('no floating point drift on cents', () => {
    expect(closingBalance(0.1, 0.2, 0)).toBe(0.3);
  });
  it('net issued = issues − reversals', () => {
    expect(netIssued([{ kind: 'issue', amount: 5000 }, { kind: 'issue', amount: 2000 }, { kind: 'reversal', amount: 2000 }])).toBe(5000);
    expect(netIssued([])).toBe(0);
  });
});

describe('input validation', () => {
  it('issue amount must be positive and sane', () => {
    expect(requireIssueAmount('5000')).toBe(5000);
    expect(() => requireIssueAmount(0)).toThrow();
    expect(() => requireIssueAmount(-1)).toThrow();
    expect(() => requireIssueAmount('abc')).toThrow();
    expect(() => requireIssueAmount(2e9)).toThrow();
  });
  it('opening balance may be zero or negative', () => {
    expect(requireOpeningBalance(0)).toBe(0);
    expect(requireOpeningBalance(-1500)).toBe(-1500);
    expect(() => requireOpeningBalance('')).not.toThrow();   // '' -> 0
    expect(() => requireOpeningBalance('x')).toThrow();
  });
});

describe('deterministic ids (match the rules regexes)', () => {
  it('period, issue and reversal ids', () => {
    expect(periodId('uidA1', '20261031', 'ab-cd-ef12345678')).toBe('fp_uidA1_20261031_abcdef12');
    expect(periodId('uidA1', '20261031', 'x')).toMatch(/^fp_uidA1_[0-9]{8}_[A-Za-z0-9]{1,8}$/);
    const r = newRequestId();
    expect(issueId('uidA1', r)).toMatch(/^mi_uidA1_[A-Za-z0-9]{1,24}$/);
    expect(issueId('u', 'same')).toBe(issueId('u', 'same'));
    expect(reversalId('mi_u_abc')).toBe('mr_mi_u_abc');
  });
});

describe('category sets', () => {
  it('live form keeps the deployed-rules set; V2 has the 8 Phase 1 categories', () => {
    expect(expenseCategoriesFor('rep').map(c => c.value)).toEqual(['Transport', 'Meals', 'Other']);
    expect(EXPENSE_CATEGORIES_V2).toHaveLength(8);
    expect(expenseCategoriesV2For('rep').map(c => c.value)).toEqual(['Transport', 'Meals', 'Other', 'EmergencyCash']);
    expect(expenseCategoriesV2For('deliverer').map(c => c.value)).toEqual(['Transport', 'Meals', 'Fuel', 'Other', 'VehicleMaintenance']);
    expect(expenseCategoriesV2For('manager')).toHaveLength(8);
    expect(subcategoriesFor('VehicleMaintenance')).toContain('Oil Change');
    expect(subcategoriesFor('Other')).toEqual([]);
    expect(categoryLabel('EmergencyCash')).toBe('Emergency Cash');
  });
});

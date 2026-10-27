import { describe, it, expect } from 'vitest';
import {
  ALL_OPERATING_EXPENSE_CATEGORIES,
  REP_EXPENSE_CATEGORY_VALUES,
  DELIVERER_EXPENSE_CATEGORY_VALUES,
  expenseCategoriesFor,
  expenseCategoryOptionsForEdit,
  repMaySeeExpense,
  expenseTilesFor,
  stockPurchaseSummary
} from '../../src/expenseCategories.js';
import {
  expensesTotalByCategory,
  expenseSummary
} from '../../src/expenses.js';

describe('RC6.4: Expanded expense categories', () => {
  it('should include new expense categories', () => {
    const categories = ALL_OPERATING_EXPENSE_CATEGORIES.map(c => c.value);
    expect(categories).toContain('Transport');
    expect(categories).toContain('Meals');
    expect(categories).toContain('Fuel');
    expect(categories).toContain('Internet');
    expect(categories).toContain('Maintenance');
    expect(categories).toContain('Packaging');
    expect(categories).toContain('Supplies');
    expect(categories).toContain('Bank');
    expect(categories).toContain('Other');
  });

  it('should define correct categories for each role', () => {
    const repCategories = expenseCategoriesFor('rep').map(c => c.value);
    expect(repCategories).toEqual(expect.arrayContaining(['Transport', 'Meals', 'Other', 'Internet', 'Packaging', 'Supplies']));
    expect(repCategories).not.toContain('Fuel');
    expect(repCategories).not.toContain('Maintenance');
    expect(repCategories).not.toContain('Bank');

    const delivererCategories = expenseCategoriesFor('deliverer').map(c => c.value);
    expect(delivererCategories).toEqual(expect.arrayContaining(['Transport', 'Meals', 'Fuel', 'Other', 'Internet', 'Maintenance', 'Packaging', 'Supplies', 'Bank']));
    expect(delivererCategories).not.toContain('Stock');

    const managerCategories = expenseCategoriesFor('manager').map(c => c.value);
    expect(managerCategories.length).toBe(ALL_OPERATING_EXPENSE_CATEGORIES.length);
  });

  it('rep should not see Fuel, Maintenance, Bank expenses', () => {
    expect(repMaySeeExpense({ category: 'Transport' }, 'rep')).toBe(true);
    expect(repMaySeeExpense({ category: 'Meals' }, 'rep')).toBe(true);
    expect(repMaySeeExpense({ category: 'Other' }, 'rep')).toBe(true);
    expect(repMaySeeExpense({ category: 'Internet' }, 'rep')).toBe(true);
    expect(repMaySeeExpense({ category: 'Packaging' }, 'rep')).toBe(true);
    expect(repMaySeeExpense({ category: 'Supplies' }, 'rep')).toBe(true);
    expect(repMaySeeExpense({ category: 'Fuel' }, 'rep')).toBe(false);
    expect(repMaySeeExpense({ category: 'Maintenance' }, 'rep')).toBe(false);
    expect(repMaySeeExpense({ category: 'Bank' }, 'rep')).toBe(false);
  });

  it('deliverer should see allowed categories', () => {
    expect(repMaySeeExpense({ category: 'Fuel' }, 'deliverer')).toBe(true);
    expect(repMaySeeExpense({ category: 'Maintenance' }, 'deliverer')).toBe(true);
    expect(repMaySeeExpense({ category: 'Bank' }, 'deliverer')).toBe(true);
    expect(repMaySeeExpense({ category: 'Transport' }, 'deliverer')).toBe(true);
  });

  it('manager should see all categories', () => {
    const allCategories = ['Transport', 'Meals', 'Fuel', 'Internet', 'Maintenance', 'Packaging', 'Supplies', 'Bank', 'Other'];
    allCategories.forEach(cat => {
      expect(repMaySeeExpense({ category: cat }, 'manager')).toBe(true);
    });
  });
});

describe('RC6.4: Expense calculations', () => {
  it('should calculate totals by category', () => {
    const expenses = [
      { category: 'Transport', amount: 100 },
      { category: 'Transport', amount: 50 },
      { category: 'Meals', amount: 30 },
      { category: 'Fuel', amount: 200 },
    ];
    const totals = expensesTotalByCategory(expenses);
    expect(totals['Transport']).toBe(150);
    expect(totals['Meals']).toBe(30);
    expect(totals['Fuel']).toBe(200);
  });

  it('should generate expense summary', () => {
    const expenses = [
      { category: 'Transport', amount: 100, paymentMethod: 'cash', receiptReference: 'R123' },
      { category: 'Transport', amount: 50, paymentMethod: 'mobile', receiptReference: null },
      { category: 'Meals', amount: 30, paymentMethod: 'cash', receiptReference: 'R124' },
      { category: 'Fuel', amount: 200, paymentMethod: 'bank', receiptReference: 'R125' },
    ];
    const summary = expenseSummary(expenses);
    expect(summary.totalAmount).toBe(380);
    expect(summary.byCategory['Transport']).toBe(150);
    expect(summary.byCategory['Meals']).toBe(30);
    expect(summary.byPaymentMethod['cash']).toBe(130);
    expect(summary.byPaymentMethod['mobile']).toBe(50);
    expect(summary.byPaymentMethod['bank']).toBe(200);
    expect(summary.missingReceipts).toBe(1); // one without receiptReference
  });

  it('should handle empty expense list', () => {
    const summary = expenseSummary([]);
    expect(summary.totalAmount).toBe(0);
    expect(summary.recordCount).toBe(0);
    expect(summary.missingReceipts).toBe(0);
    expect(Object.keys(summary.byCategory).length).toBe(0);
  });

  it('should generate expense tiles for roles', () => {
    const byCategory = { 'Transport': 100, 'Meals': 50, 'Fuel': 200 };

    const repTiles = expenseTilesFor('rep', byCategory);
    expect(repTiles.some(t => t.value === 'Transport' && t.amount === 100)).toBe(true);
    expect(repTiles.some(t => t.value === 'Meals' && t.amount === 50)).toBe(true);
    expect(repTiles.some(t => t.value === 'Fuel')).toBe(false); // rep shouldn't see fuel

    const managerTiles = expenseTilesFor('manager', byCategory);
    expect(managerTiles.some(t => t.value === 'Fuel' && t.amount === 200)).toBe(true);
  });
});

describe('RC6.4: Stock purchases', () => {
  it('should calculate stock purchase summary', () => {
    const purchases = [
      { invoiceTotal: 1000, amountPaid: 1000, balanceDue: 0, paymentStatus: 'paid' },
      { invoiceTotal: 500, amountPaid: 200, balanceDue: 300, paymentStatus: 'part-paid' },
      { invoiceTotal: 800, amountPaid: 0, balanceDue: 800, paymentStatus: 'unpaid' },
    ];
    const summary = stockPurchaseSummary(purchases);
    expect(summary.total).toBe(2300);
    expect(summary.paid).toBe(1200);
    expect(summary.due).toBe(1100);
    expect(summary.unpaidCount).toBe(2);
  });

  it('should handle empty stock purchases list', () => {
    const summary = stockPurchaseSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.paid).toBe(0);
    expect(summary.due).toBe(0);
    expect(summary.unpaidCount).toBe(0);
  });

  it('should handle null/undefined stock purchases', () => {
    expect(stockPurchaseSummary(null)).toEqual({ total: 0, paid: 0, due: 0, unpaidCount: 0 });
    expect(stockPurchaseSummary(undefined)).toEqual({ total: 0, paid: 0, due: 0, unpaidCount: 0 });
  });
});

describe('RC6.4: Expense category options for edit', () => {
  it('rep should see only rep categories', () => {
    const options = expenseCategoryOptionsForEdit('rep', 'Transport');
    const values = options.map(o => o.value);
    expect(values).toContain('Transport');
    expect(values).not.toContain('Fuel');
    expect(values).not.toContain('Maintenance');
  });

  it('manager should see all categories including legacy', () => {
    const options = expenseCategoryOptionsForEdit('manager', 'Transport');
    const values = options.map(o => o.value);
    expect(values).toContain('Transport');
    expect(values).toContain('Fuel');
    expect(values).toContain('Stock'); // legacy
  });

  it('manager editing legacy Stock record should see it', () => {
    const options = expenseCategoryOptionsForEdit('manager', 'Stock');
    const values = options.map(o => o.value);
    expect(values).toContain('Stock');
  });

  it('manager editing unexpected category should include it', () => {
    const options = expenseCategoryOptionsForEdit('manager', 'UnknownCategory');
    const values = options.map(o => o.value);
    expect(values).toContain('UnknownCategory');
  });
});

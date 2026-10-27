// RC6.4: expense categories and stock purchase separation (pure, no Firestore, no DOM).
//
// A sales rep only records the costs of his own field day: transport, meals and other small items.
// Fuel belongs to the delivery vehicle (deliverer logs it). New categories like Internet/Airtime/Data,
// Vehicle Maintenance, Packaging, Operating Supplies and Bank/Mobile Money Fees are available.
// Stock purchases are a separate collection (stockPurchases) with distinct fields: supplier, invoice number,
// purchase date, invoice total, amount paid, balance due, due date, payment status.
//
// Role boundaries (enforced by Firestore rules):
// - Rep (submitter): Transport, Meals, Other, Internet, Maintenance, Packaging, Supplies, Bank Fees (own only)
// - Deliverer: Fuel, Transport, Meals, Other, Internet, Maintenance, Packaging, Supplies, Bank Fees (own only)
// - Manager: all operating expenses + all stock purchases

export const ALL_OPERATING_EXPENSE_CATEGORIES = [
  { value: 'Transport', label: 'Transport', roles: ['rep', 'deliverer', 'manager'] },
  { value: 'Meals', label: 'Meals', roles: ['rep', 'deliverer', 'manager'] },
  { value: 'Fuel', label: 'Fuel', roles: ['deliverer', 'manager'] },
  { value: 'Internet', label: 'Internet / Airtime / Data', roles: ['rep', 'deliverer', 'manager'] },
  { value: 'Maintenance', label: 'Vehicle Maintenance / Repairs', roles: ['deliverer', 'manager'] },
  { value: 'Packaging', label: 'Packaging', roles: ['rep', 'deliverer', 'manager'] },
  { value: 'Supplies', label: 'Operating Supplies', roles: ['rep', 'deliverer', 'manager'] },
  { value: 'Bank', label: 'Bank / Mobile Money Fees', roles: ['deliverer', 'manager'] },
  { value: 'Other', label: 'Other', roles: ['rep', 'deliverer', 'manager'] },
];

// Historic categories that may appear in legacy records
export const LEGACY_EXPENSE_CATEGORIES = [
  { value: 'Stock', label: 'Stock Purchase (legacy)', roles: ['manager'] },
];

export const REP_EXPENSE_CATEGORY_VALUES = ['Transport', 'Meals', 'Other', 'Internet', 'Packaging', 'Supplies'];
export const DELIVERER_EXPENSE_CATEGORY_VALUES = ['Transport', 'Meals', 'Fuel', 'Other', 'Internet', 'Maintenance', 'Packaging', 'Supplies', 'Bank'];

export function expenseCategoriesFor(userRole) {
  // userRole: 'rep', 'deliverer', 'manager', or boolean (backward compat: false=rep, true=manager)
  let role = userRole;
  if (typeof userRole === 'boolean') {
    role = userRole ? 'manager' : 'rep';
  }
  if (!role || role === 'manager') {
    return ALL_OPERATING_EXPENSE_CATEGORIES.slice();
  }
  return ALL_OPERATING_EXPENSE_CATEGORIES.filter(c => c.roles.includes(role));
}

// Options for an edit box. A manager: every category, plus legacy categories and the record's own if unexpected.
// A rep/deliverer: only their allowed categories; they never hold a record outside them (the query and rules exclude them).
export function expenseCategoryOptionsForEdit(userRole, current) {
  // userRole: 'rep', 'deliverer', 'manager', or boolean (backward compat: false=rep, true=manager)
  let role = userRole;
  if (typeof userRole === 'boolean') {
    role = userRole ? 'manager' : 'rep';
  }

  const list = expenseCategoriesFor(role);
  if (role === 'manager') {
    list.push(...LEGACY_EXPENSE_CATEGORIES);
    if (current && !ALL_OPERATING_EXPENSE_CATEGORIES.concat(LEGACY_EXPENSE_CATEGORIES).some(c => c.value === current)) {
      list.push({ value: String(current), label: String(current), roles: ['manager'] });
    }
  }
  return list;
}

export function repMaySeeExpense(e, userRole = 'rep') {
  if (!e) return false;
  const allowed = expenseCategoriesFor(userRole).map(c => c.value);
  return allowed.includes(e.category);
}

// Summary tiles: exactly the role's categories. For reps/deliverers, records outside them are never counted.
export function expenseTilesFor(userRole, byCategory) {
  // userRole: 'rep', 'deliverer', 'manager', or boolean (backward compat: false=rep, true=manager)
  let role = userRole;
  if (typeof userRole === 'boolean') {
    role = userRole ? 'manager' : 'rep';
  }
  return expenseCategoriesFor(role).map(c => ({ ...c, amount: (byCategory && byCategory[c.value]) || 0 }));
}

// Stock purchase summary (manager only)
export function stockPurchaseSummary(purchases) {
  if (!purchases || !Array.isArray(purchases)) return { total: 0, paid: 0, due: 0, unpaidCount: 0 };
  const total = purchases.reduce((sum, p) => sum + (p.invoiceTotal || 0), 0);
  const paid = purchases.reduce((sum, p) => sum + (p.amountPaid || 0), 0);
  const due = purchases.reduce((sum, p) => sum + (p.balanceDue || 0), 0);
  const unpaidCount = purchases.filter(p => p.paymentStatus !== 'paid').length;
  return { total, paid, due, unpaidCount };
}

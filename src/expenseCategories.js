// RC6.4: expense categories (simplified, no stock purchases or optional fields).
//
// A sales rep only records the costs of his own field day: transport, meals and other small items.
// Fuel belongs to the delivery vehicle (deliverer logs it).
// Stock purchases are not tracked separately; they are part of the main business flow.
//
// Role boundaries (enforced by Firestore rules):
// - Rep (submitter): Transport, Meals, Other (own only)
// - Deliverer: Fuel, Transport, Meals, Other (own only)
// - Manager: all operating expenses

export const ALL_OPERATING_EXPENSE_CATEGORIES = [
  { value: 'Transport', label: 'Transport', roles: ['rep', 'deliverer', 'manager'] },
  { value: 'Meals', label: 'Meals', roles: ['rep', 'deliverer', 'manager'] },
  { value: 'Fuel', label: 'Fuel', roles: ['deliverer', 'manager'] },
  { value: 'Other', label: 'Other', roles: ['rep', 'deliverer', 'manager'] },
];

// Historic categories that may appear in legacy records
export const LEGACY_EXPENSE_CATEGORIES = [
  { value: 'Stock', label: 'Stock Purchase (legacy)', roles: ['manager'] },
];

export const REP_EXPENSE_CATEGORY_VALUES = ['Transport', 'Meals', 'Other'];
export const DELIVERER_EXPENSE_CATEGORY_VALUES = ['Transport', 'Meals', 'Fuel', 'Other'];

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

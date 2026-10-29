// RC6.4: expense categories (same set as RC6.3; the RC6.4 expansion was withdrawn).
//
// A sales rep only records the costs of his own field day: transport, meals and other small items.
// Fuel belongs to the delivery vehicle (deliverer logs it). Stock Purchase is a manager cost.
//
// Role boundaries (enforced by Firestore rules):
// - Rep (submitter): Transport, Meals, Other (own only)
// - Deliverer: Fuel, Transport, Meals, Other (own only)
// - Manager: Transport, Meals, Fuel, Stock Purchase, Other (everyone's)

export const ALL_OPERATING_EXPENSE_CATEGORIES = [
  { value: 'Transport', label: 'Transport', roles: ['rep', 'deliverer', 'manager'] },
  { value: 'Meals', label: 'Meals', roles: ['rep', 'deliverer', 'manager'] },
  { value: 'Fuel', label: 'Fuel', roles: ['deliverer', 'manager'] },
  { value: 'Stock', label: 'Stock Purchase', roles: ['manager'] },
  { value: 'Other', label: 'Other', roles: ['rep', 'deliverer', 'manager'] },
];

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

// Options for an edit box. A manager: every category, plus the record's own if it is unexpected.
// A rep/deliverer: only their allowed categories; they never hold a record outside them (the query and rules exclude them).
export function expenseCategoryOptionsForEdit(userRole, current) {
  // userRole: 'rep', 'deliverer', 'manager', or boolean (backward compat: false=rep, true=manager)
  let role = userRole;
  if (typeof userRole === 'boolean') {
    role = userRole ? 'manager' : 'rep';
  }

  const list = expenseCategoriesFor(role);
  if (role === 'manager') {
    if (current && !ALL_OPERATING_EXPENSE_CATEGORIES.some(c => c.value === current)) {
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

// Expense categories.
//
// TWO SETS, deliberately kept apart:
//
// 1. ALL_OPERATING_EXPENSE_CATEGORIES (5): the LIVE expense form (Expenses tab). These match the deployed
//    `expenses` rules exactly (rep: Transport, Meals, Other; deliverer: + Fuel; manager: + Stock). Do not add
//    to this list without changing repExpenseCategoryOk / delivererExpenseCategoryOk in rules/firestore.rules,
//    or a rep's save will be refused.
//
// 2. EXPENSE_CATEGORIES_V2 (8): Phase 1 expense control (float settings, expense reports). Adds
//    Emergency Cash (rep, manager), Manager Business (manager), Vehicle/Maintenance (deliverer, manager).
//    Used by floatSettings.allowedCategories and, from Stage 3, by expenseLines.

export const ALL_OPERATING_EXPENSE_CATEGORIES = [
  { value: 'Transport', label: 'Transport', roles: ['rep', 'deliverer', 'manager'] },
  { value: 'Meals', label: 'Meals', roles: ['rep', 'deliverer', 'manager'] },
  { value: 'Fuel', label: 'Fuel', roles: ['deliverer', 'manager'] },
  { value: 'Stock', label: 'Stock Purchase', roles: ['manager'] },
  { value: 'Other', label: 'Other', roles: ['rep', 'deliverer', 'manager'] },
];

export const EXPENSE_CATEGORIES_V2 = [
  ...ALL_OPERATING_EXPENSE_CATEGORIES,
  { value: 'EmergencyCash', label: 'Emergency Cash', roles: ['rep', 'manager'] },
  { value: 'ManagerBusiness', label: 'Manager Business', roles: ['manager'] },
  { value: 'VehicleMaintenance', label: 'Vehicle/Maintenance', roles: ['deliverer', 'manager'] },
];

// Subcategories per category (Phase 1). Empty array = no subcategory selector.
export const EXPENSE_SUBCATEGORIES = {
  Transport: ['Minibus', 'Taxi / Kabaza', 'Fuel (own vehicle)', 'Other'],
  Meals: ['Breakfast', 'Lunch', 'Dinner', 'Team Meal', 'Other'],
  Fuel: ['Diesel', 'Petrol'],
  Stock: ['Stock Purchase', 'Other'],
  Other: [],
  EmergencyCash: ['Medical', 'Vehicle Breakdown', 'Customer Emergency', 'Other'],
  ManagerBusiness: ['Client Entertainment', 'Office Supplies', 'Bank Charges', 'Licensing/Permits', 'Other'],
  VehicleMaintenance: ['Oil Change', 'Tyre Repair', 'Brake Service', 'Battery', 'Wash/Clean', 'Other'],
};

function normaliseRole(userRole) {
  // userRole: 'rep', 'deliverer', 'manager', or boolean (backward compat: false=rep, true=manager)
  if (typeof userRole === 'boolean') return userRole ? 'manager' : 'rep';
  return userRole;
}

function filterFor(list, userRole) {
  const role = normaliseRole(userRole);
  if (!role || role === 'manager') return list.slice();
  return list.filter(c => c.roles.includes(role));
}

// LIVE expense form (unchanged behaviour).
export function expenseCategoriesFor(userRole) {
  return filterFor(ALL_OPERATING_EXPENSE_CATEGORIES, userRole);
}

// Phase 1 expense control.
export function expenseCategoriesV2For(userRole) {
  return filterFor(EXPENSE_CATEGORIES_V2, userRole);
}

export function categoryLabel(value) {
  const c = EXPENSE_CATEGORIES_V2.find(x => x.value === value);
  return c ? c.label : String(value || '');
}

export function subcategoriesFor(categoryValue) {
  return EXPENSE_SUBCATEGORIES[categoryValue] || [];
}

// Options for an edit box. A manager: every category, plus the record's own if it is unexpected.
// A rep/deliverer: only their allowed categories.
export function expenseCategoryOptionsForEdit(userRole, current) {
  const role = normaliseRole(userRole);
  const list = expenseCategoriesFor(role);
  if (role === 'manager' && current && !ALL_OPERATING_EXPENSE_CATEGORIES.some(c => c.value === current)) {
    list.push({ value: String(current), label: categoryLabel(current), roles: ['manager'] });
  }
  return list;
}

export function repMaySeeExpense(e, userRole = 'rep') {
  if (!e) return false;
  return expenseCategoriesFor(userRole).map(c => c.value).includes(e.category);
}

// Summary tiles: exactly the role's categories.
export function expenseTilesFor(userRole, byCategory) {
  return expenseCategoriesFor(normaliseRole(userRole)).map(c => ({ ...c, amount: (byCategory && byCategory[c.value]) || 0 }));
}

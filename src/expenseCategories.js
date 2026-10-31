// Phase 1, Stage 1: expense categories expanded from 5 to 8.
//
// Role boundaries (enforced by Firestore rules + UI filtering):
// - Rep (submitter):  Transport, Meals, Other, Emergency Cash
// - Deliverer:        Transport, Meals, Fuel, Other, Vehicle/Maintenance
// - Manager:          All 8 categories (everyone's records)
//
// IMPORTANT: REP_EXPENSE_CATEGORIES in expenses.js is ['Transport','Meals','Other']
// and is intentionally NOT changed here — those are the categories a rep's Firestore
// query is filtered by (the query/rules block Fuel, Stock, and the new categories from rep reads).
// The three new categories (Emergency Cash, Manager Business, Vehicle/Maintenance) bypass
// the legacy query path and will be accessed through the Phase 1 expense report system.

export const ALL_OPERATING_EXPENSE_CATEGORIES = [
  { value: 'Transport',    label: 'Transport',           roles: ['rep', 'deliverer', 'manager'] },
  { value: 'Meals',        label: 'Meals',               roles: ['rep', 'deliverer', 'manager'] },
  { value: 'Fuel',         label: 'Fuel',                roles: ['deliverer', 'manager'] },
  { value: 'Stock',        label: 'Stock Purchase',      roles: ['manager'] },
  { value: 'Other',        label: 'Other',               roles: ['rep', 'deliverer', 'manager'] },
  // Phase 1 additions:
  { value: 'EmergencyCash',       label: 'Emergency Cash',       roles: ['rep', 'manager'] },
  { value: 'ManagerBusiness',     label: 'Manager Business',     roles: ['manager'] },
  { value: 'VehicleMaintenance',  label: 'Vehicle/Maintenance',  roles: ['deliverer', 'manager'] },
];

// Subcategories per category (Phase 1). Each entry is an array of string options.
// An empty array means no subcategory selector is shown.
export const EXPENSE_SUBCATEGORIES = {
  Transport: ['Minibus', 'Taxi', 'Fuel (own vehicle)', 'Other'],
  Meals: ['Breakfast', 'Lunch', 'Dinner', 'Team Meal', 'Other'],
  Fuel: ['Diesel', 'Petrol', 'Other'],
  Stock: ['Maize Flour', 'Sugar', 'Rice', 'Other Groceries', 'Other'],
  Other: [],
  EmergencyCash: ['Medical', 'Vehicle Breakdown', 'Customer Emergency', 'Other'],
  ManagerBusiness: ['Client Entertainment', 'Office Supplies', 'Bank Charges', 'Licensing/Permits', 'Other'],
  VehicleMaintenance: ['Oil Change', 'Tyre Repair', 'Brake Service', 'Battery', 'Wash/Clean', 'Other'],
};

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
// A rep/deliverer: only their allowed categories.
export function expenseCategoryOptionsForEdit(userRole, current) {
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

// Returns subcategory options for a given category value. Empty array = no subcategory.
export function subcategoriesFor(categoryValue) {
  return EXPENSE_SUBCATEGORIES[categoryValue] || [];
}

export function repMaySeeExpense(e, userRole = 'rep') {
  if (!e) return false;
  const allowed = expenseCategoriesFor(userRole).map(c => c.value);
  return allowed.includes(e.category);
}

// Summary tiles: exactly the role's categories. For reps/deliverers, records outside them are never counted.
export function expenseTilesFor(userRole, byCategory) {
  let role = userRole;
  if (typeof userRole === 'boolean') {
    role = userRole ? 'manager' : 'rep';
  }
  return expenseCategoriesFor(role).map(c => ({ ...c, amount: (byCategory && byCategory[c.value]) || 0 }));
}

import { db } from './firebase.js';
import { doc } from 'firebase/firestore';
import { malawiYear } from './malawiTime.js';

export const ORDER_COUNTER_DOC = doc(db, 'orderCounters', 'naisiOrder');

function pad4(n) {
  return String(n).padStart(4, '0');
}

// Order numbers are issued ONLY inside the transaction that creates the order (visits.js submitOrderWithVisit for
// reps, managerOrders.js for orders a manager enters). The security rules refuse any counter step that does not
// come with its order in the same commit, and nobody (manager included) can set the order counter by hand,
// so order numbers cannot be skipped, reused or changed by an invoice-number adjustment. The year is the Malawi year.
export function buildOrderNo(counter, now = new Date()) {
  return `ORD-${malawiYear(now)}-${pad4(counter)}`;
}

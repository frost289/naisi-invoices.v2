# Daily sales-rep visits

STATUS: not ready for rollout. The real `firestore.rules` has not been supplied, so everything that depends on it is BLOCKED (section 6). Prerequisite: the revision-2 patch (commit e1131f3) must be applied first.

## 1. How a rep uses it
1. Log in. "Today's Visits" opens automatically and lists active customers whose weekly visit day is today (Malawi time, Africa/Blantyre, whatever the phone's clock zone says). All reps see the same list.
2. The strip at the top shows: Scheduled today, Visited, Still to visit, Orders taken, No-order visits. It reloads from saved visits on refresh or return.
3. Tap a shop. Choose **Order Placed** or **No Order**.
   - Order Placed: pick products from the catalogue, enter whole-number quantities, Save. The order (status Submitted, existing approval workflow) and the visit are written in one transaction. If the save fails, neither exists; tap Save again, it will not duplicate.
   - No Order: pick a reason (nothing is preselected): Shop still has stock; Price too high; Stock unavailable; Shop owner unavailable; Shop closed; No money today; Not interested; Other. "Other" needs a written explanation (min 3 characters); the rest allow optional details (max 500).
4. A second visit to the same scheduled shop is allowed and kept in history, but counts once toward "Visited". Shops visited that are not scheduled today appear under "Also visited today" and do not reduce "Still to visit".

## 2. How a manager uses it
- Weekly schedule card (Customers): set or change a customer's visit day (Mon-Sat or none). Deactivating a customer removes them from lists.
- Performance view: choose date range and optionally one rep. Per rep: scheduled, distinct visited, still due, orders, no-order, extra visits, plus tables of shops still due, no-order reasons/explanations, orders taken (View order opens the linked order) and all visits. Reps with no visits are listed with zeros.

## 3. Definitions
- Scheduled = active customers whose weekly day matches that date's weekday (current schedule).
- Visited = distinct scheduled customers with at least one recorded visit by that rep on that date. Still due = scheduled - visited.
- Orders taken / No-order = all recorded visits of that outcome, including repeats and unscheduled shops.
- Coverage % = visited / scheduled. Conversion % = orders / all recorded visits. Shown as "-" when the divisor is 0.
- Order value is snapshotted on the visit. Visits recorded before this feature have no value and show "-"; they are excluded from totals, never counted as 0.

## 4. Historical schedule behaviour
Past dates are measured against the CURRENT weekly schedule. If a customer's visit day or active status changes later, old days' "scheduled" and "still due" totals change with it. Each customer records `assignedDayChangedAt`; when it falls inside a report range the report shows a warning. Visits keep `scheduledDay` and `wasScheduled` as snapshots for audit, but totals do not use them.

## 5. Data model changes (check against real rules)
New/changed fields:
- `visits` docs (schemaVersion 2): requestId, customerId, customerName, repId, repEmail, date (Malawi yyyy-mm-dd, from device clock), scheduledDay, wasScheduled, outcome ('order'|'no_order'), reasonNoOrder, reasonNotes, orderId, orderNo, orderValue, createdAt (server timestamp).
- Deterministic ids: visit `v_<uid>_<requestId>`, order `o_<uid>_<requestId>`.
- `orders`: new field `visitId`.
- `customers`: new field `assignedDayChangedAt`.
- Transaction needs: create order + create visit + update order counter (+1) in one commit; read of `config/roles` submitters (manager report rep list); read of all visits by managers; reps read own visits by `repId`+`date`.
- Indexes: none new expected (equality-only queries for reps; manager report filters by date range, check whether a composite index is needed if combined with `repId`).
- Proposed rules: `rules/invoicing.rules.fragment` ("DAILY VISITS"), UNVERIFIED proposal only. Emulator tests in `tests/rules` are written but NOT RUN.

## 6. Limitations
- Real rules unverified: BLOCKED. No server-side enforcement of reason/explanation, deterministic ids, or order+visit pairing is confirmed. Old open browser tabs can still write unvalidated visits/orders until rules enforce the shape.
- `date` comes from the device clock (Malawi-converted); `createdAt` is the authoritative server time. A wrong phone clock can file a visit under the wrong date.
- Historical schedule totals follow the current schedule (section 4).
- Legacy visits lack `wasScheduled`/`orderValue`.
- Unscheduled visits don't count toward completion.
- Tested against an in-memory stand-in, not the Firestore/Auth emulators.

## 7. Applying
    git am 0001-*.patch    # on top of e1131f3 (revision 2)
    cd tests && npm install && npm test
    npm run test:e2e
Do not deploy until the real rules have been checked.

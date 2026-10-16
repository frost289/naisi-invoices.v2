# Daily sales-rep visits

VERDICT: NOT SAFE TO DEPLOY - rules unverified. The real `firestore.rules` was supplied on 2026-10-16 and read against the app (see `docs/RULES-REVIEW.md`): a rep's first save is predicted to be refused until a small rules change (stage 1) is made. Nothing has been run on the emulator, so every rules result is still BLOCKED/NOT RUN (section 6).

Patch order: (1) revision-2 patch (commit e1131f3), (2) daily-visits patch `0001-Add-daily-sales-rep-visit-workflow...`, (3) corrective patch `0002-...`, (4) rules review patch `0003-Add-rules-review-...` (docs and rules tests only; no app change).

## 1. How a rep uses it
1. Log in. "Today's Visits" opens automatically and lists active customers whose weekly visit day is today (Malawi time, Africa/Blantyre, whatever the phone's clock zone says). All reps see the same list.
2. The strip at the top shows: Scheduled today, Visited, Still to visit, Orders taken, No-order visits. It reloads from saved visits on refresh or return.
3. Tap a shop. Choose **Order Placed** or **No Order**.
   - Order Placed: pick products from the catalogue, enter whole-number quantities, Save. The order (status Submitted, existing approval workflow) and the visit are written in one transaction. If the save fails, neither exists; tap Save again, it will not duplicate.
   - If the connection drops AFTER the save went through and you tap Save again with the same details, the app tells you it was already saved and shows the same order number.
   - If you CHANGE something (quantity, product, price, notes, shop, or Order vs No Order, or the reason/explanation) and tap Save again after a failed or uncertain save, the app does NOT save the change. A box shows what was already saved and says your new details were not saved. You then choose: "Keep what was saved" (closes the form and reloads progress), or "Record my new details as a NEW visit" (a deliberate extra visit with its own order). The app never starts a new visit by itself.
   - No Order: pick a reason (nothing is preselected): Shop still has stock; Price too high; Stock unavailable; Shop owner unavailable; Shop closed; No money today; Not interested; Other. "Other" needs a written explanation (min 3 characters); the rest allow optional details (max 500).
4. A second visit to the same scheduled shop is allowed and kept in history, but counts once toward "Visited". Shops visited that are not scheduled today appear under "Also visited today" and do not reduce "Still to visit".

## 2. How a manager uses it
- Weekly schedule card (Customers): set or change a customer's visit day (Mon-Sat or none). Deactivating a customer removes them from lists.
- Performance view: choose a date range (at most 366 days, both end dates counted; a longer range is refused with a message, never shortened). The line "Showing: ..." states the dates the report on screen covers, and warns if you have edited the date boxes since. If you change dates while a report is still loading, the newest request wins and older answers are ignored. Choose and optionally one rep. Per rep: scheduled, distinct visited, still due, orders, no-order, extra visits, plus tables of shops still due, no-order reasons/explanations, orders taken (View order opens the linked order) and all visits. Reps with no visits are listed with zeros.

## 3. Definitions
- Scheduled = active customers whose weekly day matches that date's weekday (current schedule).
- Visited = distinct scheduled customers with at least one recorded visit by that rep on that date. Still due = scheduled - visited.
- Orders taken / No-order = all recorded visits of that outcome, including repeats and unscheduled shops.
- Coverage % = visited / scheduled. Conversion % = orders / all recorded visits. Shown as "-" when the divisor is 0.
- All figures in one report use the same dates, so Scheduled, Visited, Orders and No order always agree on the interval.
- Order value is snapshotted on the visit. Visits recorded before this feature have no value and show "-"; they are excluded from totals, never counted as 0.

## 4. Historical schedule behaviour
Past dates are measured against the CURRENT weekly schedule. If a customer's visit day or active status changes later, old days' **Scheduled, Visited and Still due** (and so Coverage %) change with it, because Visited counts only distinct customers who are scheduled on that date under today's schedule. A shop moved to another day, or deactivated, drops out of those counts for old dates even if it was visited. **Orders and No order** are counted straight from saved visits and do not change (a visit to a shop that is not scheduled on that date is counted there and listed as an extra visit). Each customer records `assignedDayChangedAt`; when it falls inside a report range the report shows a warning saying this. Visits keep `scheduledDay` and `wasScheduled` as snapshots for audit, but totals do not use them.

## 5. Data model changes (check against real rules)
New/changed fields:
- `visits` docs (schemaVersion 2): requestId, customerId, customerName, repId, repEmail, date (Malawi yyyy-mm-dd, from device clock), scheduledDay, wasScheduled, outcome (the text 'Order Placed' or 'No Order', exactly as stored), reasonNoOrder, reasonNotes, orderId, orderNo, orderValue, createdAt (server timestamp).
- Deterministic ids: visit `v_<uid>_<requestId>`, order `o_<uid>_<requestId>`.
- `orders`: new field `visitId`.
- `customers`: new field `assignedDayChangedAt`.
- Transaction needs: create order + create visit + update order counter (+1) in one commit; the order transaction also READS the order document at its deterministic id (it does not exist on a first save; on a retry it is compared with the incoming details), so rules must allow `get` of that path for the rep who owns it, including when it does not exist; read of `config/roles` submitters (manager report rep list); read of all visits by managers; reps read own visits by `repId`+`date`.
- Indexes: none new expected (equality-only queries for reps; manager report filters by date range, check whether a composite index is needed if combined with `repId`).
- Rules: the supplied rules were reviewed in `docs/RULES-REVIEW.md`; proposed changes are in `rules/proposed/` (stage 1 required, stage 2 optional) and are UNVERIFIED. The older `rules/invoicing.rules.fragment` text is superseded. Emulator tests in `tests/rules` are written but NOT RUN.

## 5b. Retry rules (same request id)
Identical = same customer, outcome, products, quantities, prices, totals, order notes (trimmed), and for No Order the same reason and explanation (trimmed). Identical: returns the saved result, writes nothing, uses no number. Different: error code `visit-conflict`, nothing written, the error carries what was saved. Product names are not compared (only product id, quantity, price, total). Line order matters.

## 6. Limitations
- Rules: a rep's first save is predicted to be refused by the supplied rules until stage 1 is deployed (RULES-REVIEW.md section 1); not run on the emulator: BLOCKED. No server-side enforcement of reason/explanation, deterministic ids, or order+visit pairing is confirmed. Old open browser tabs can still write unvalidated visits/orders until rules enforce the shape.
- `date` comes from the device clock (Malawi-converted); `createdAt` is the authoritative server time. A wrong phone clock can file a visit under the wrong date.
- Historical Scheduled, Visited and Still due follow the current schedule (section 4).
- Maximum report range is 366 days; longer needs two reports.
- A rep who changed details after an uncertain save must use the conflict box; there is no merge or edit of a saved visit.
- Legacy visits lack `wasScheduled`/`orderValue`.
- Unscheduled visits don't count toward completion.
- Tested against an in-memory stand-in, not the Firestore/Auth emulators.

## 7. Applying
    git am 0001-*.patch    # on top of e1131f3 (revision 2)
    cd tests && npm install && npm test
    npm run test:e2e
Do not deploy until the real rules have been checked.

> **CORRECTION (RC6.3, 20 October 2026).** This RC6.2 note wrongly recorded "Orders stay blocked without a pin" as an owner decision. The owner's actual decision is: **a missing customer location shows a clear reminder but does NOT block order submission.** RC6.2 implemented the wrong behaviour; RC6.3 corrects it in the screens, the order-saving functions and the Firestore rules. RC6.2 also said "Rules are unchanged" and "pin fields are informational and not checked by the rules": both are superseded by RC6.3 (see docs/RC6.3-CHANGES.md). Do not use RC6.2.

# RC6.2 — owner change requests (built on RC6.1)

Build RC6.2, package 6.2.0-rc1. Prepared 20 October 2026. **Real Firebase verification is still incomplete. This build is not approved for production.** Every RC6.1 gate in RC6.1-DEVELOPER-REVIEW-GUIDE.md and RC6.1-OPERATIONS-PLAN.md still applies to this build without change. `rules/firestore.rules` is byte-for-byte unchanged (the SHA-256 is still the one in HASHES.txt).

## What changed

| # | Request | Change | Files |
|---|---|---|---|
| 1 | Reps should see only their own expenses. They should not see fuel or stock purchases | A rep can log only **Transport, Meals and Other**. The summary tiles show only those three. The only exception is an older Fuel or Stock record of his own: it still gets a tile, so the tiles add up to the total. Editing an older record keeps its category. Reps already saw only their own expenses (query `createdBy == uid`, enforced by the rules). Managers keep all five categories. The delivery screen still has Fuel | `src/expenseCategories.js` (new), `src/main.js` |
| 2 | Push reps to add customer locations | (a) Today's Visits has a new **"Need a pin"** counter and a banner naming the shops on today's list that have no location. (b) Picking an unpinned shop shows **"Save this shop's location"** at the top of the visit card. The map opens at the phone's GPS position. (c) A No-order visit to an unpinned shop only saves after the rep makes an explicit choice: he pins it, or he taps "Can't pin now". (d) Orders still require a pin, as in RC6.1. (e) Each saved pin records `pinnedBy`, `pinnedByEmail` and `pinnedAt` (server time). The manager sees "pinned this week" for each rep | `index.html`, `src/main.js`, `src/customers.js`, `src/style.css` |
| 3 | No Walk-in Invoice tab for now | The tab is hidden for everyone (`WALK_IN_INVOICE_TAB = false` in `src/main.js`). Setting it to `true` brings the tab back. The form view is kept, because invoicing an order and editing an invoice still use it. The invoice-numbering box (next number, change with a reason, change history) moves to the **Invoices** tab | `src/main.js` |
| 4 | Weekly schedule was disorganised. The manager had two schedules that need to become one | A new manager tab, **Weekly Schedule**, replaces both the old "Weekly Visit Schedule" card (Customers tab) and the Day dropdowns in the customer table. It has: a week navigator; a rep filter; KPI tiles (planned, visited/coverage, orders and value, no order, missed, extra shops, shops without a location, shops awaiting a day); the "Awaiting a visit day" list; one card per day, Mon–Sat. Each day card lists every planned shop with its outcome (✓ order no. and value · ✕ no-order reason · ! missed · • due today · ○ planned) and the rep who made the visit. It also lists shops visited that day that were not planned. Today and upcoming days have a day selector for moving a shop. Past days are read-only. Distance suggestions and spreadsheet import are under "Planning tools" on the same tab. The customer table shows the day as text only | `src/weekBoard.js` (new), `index.html`, `src/main.js`, `src/style.css` |

Plan source on the board: a past day or today with dated schedule history uses the plan that applied **on that day** (`targetsForDate`). Upcoming days, and dates before the history began, use the current plan, and the screen says so. Moving a shop uses the same transaction as before: `setCustomerVisitDay` plus a `scheduleChanges` history entry, with an `expectedDay` stale check.

## Security / rules notes for the developer

- Rules are unchanged. The expense category limit for reps is a **screen rule only**. A modified client could still post a Fuel expense, but only as its own record. If the owner wants this enforced on the server, add `request.resource.data.category in ['Transport','Meals','Other']` to the submitter branch of `expenses` create/update. That would be a rules change and needs the full rules suite.
- `pinnedBy` / `pinnedByEmail` / `pinnedAt` are new optional customer fields. The existing customer update rule already allows reps and managers to write them, because they are not schedule or merge keys. The rules do not check that `pinnedBy` equals the caller. Treat the field as informational.

## Tests

- Unit: `tests/unit/rc62.test.js` (new, 10 tests). Full mocked unit suite: **31 files, 633 passed, 0 failed**.
- Browser (mocked backend, real Chromium): new `tests/e2e/rc62.e2e.mjs` E56–E65, added to `npm run test:e2e`. Full browser suite: **64 checks passed, 0 failed** (visits E1–E25, decisions E26–E55, RC6.2 E56–E65). Run on Node 22.22 in a Linux sandbox. The package engine asks for Node ≥ 24.12, so re-run on the supported machine.
- Production build: OK, `dist/build-id.txt` = RC6.2. The existing large-bundle warning is still there.
- Not run here: rules emulator suite and real Auth/Firestore workflows. These gates stay BLOCKED until the developer runs them.

### Existing tests changed (disclosed)
1. `visits.e2e.mjs` E21: changes Echo's day on the Weekly Schedule board instead of the old day tabs. The assertions are unchanged.
2. `decisions.e2e.mjs` E29: opens the Weekly Schedule tab instead of Customers. The assertions are unchanged.
3. E34: reaches invoice numbering from the Invoices tab. The assertions are unchanged.
4. E40: the walk-in issue/retry/double-click scenario is **replaced** by a check that the tab is hidden for managers, numbering is still reachable, and no stand-alone invoice exists. Stand-alone idempotency is still covered by `unit/invoicing.test.js` and the rules suite.
5. E43/E47: open "Planning tools" on the Weekly Schedule tab first. The assertions are unchanged.
6. E51: also asserts that a rep has no Weekly Schedule tab.
7. `unit/maintenance.test.js`: version/build id is now 6.2.0-rc1 / RC6.2.

No assertion was removed to obtain a pass, other than the E40 replacement described above.

## Owner decisions recorded
- Rep expense categories: Transport, Meals, Other.
- Walk-in invoices: off for now.
- ~~Unpinned shop on a No-order visit: the rep must pin it or tap "Can't pin now" (not blocked). Orders stay blocked without a pin.~~ **Incorrect - see the correction at the top. Owner decision: reminder only; orders are never blocked by a missing location.**

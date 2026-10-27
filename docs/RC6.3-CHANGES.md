# RC6.3 — corrections to RC6.2 after owner review

Build **RC6.3**, package **6.3.0-rc1**. Prepared 20 October 2026 (Africa/Blantyre). Built on RC6.2 (which was built on RC6.1).

**NOT APPROVED FOR PRODUCTION. Real Firebase (emulator) verification has NOT been run.** The rules file changed in this release, so the emulator rules suite is a hard gate. Do not deploy until every gate under "Before release" passes.

Purpose of the release: give management a reliable view of each sales rep's planned activities, completed visits, orders and missed visits.

## 1. Missing customer locations never block orders (owner decision)

The owner's decision is: **a missing location shows a clear reminder, but an order can still be submitted.** RC6.2 blocked such orders and its notes wrongly said that was the owner's choice. `docs/RC6.2-CHANGES.md` now carries a correction.

| Layer | Change |
|---|---|
| Rep screen | The "Save this shop's location" reminder, the "Need a pin" counter and the banner all stay. The order form opens without a pin, and the map is no longer forced open. "Not now" only hides the buttons. No-order visits are not blocked either. After saving, the rep sees a toast: "flagged No location for delivery". |
| Manager screens | Manager-entered orders are allowed for unpinned shops, with a warning. The Orders list shows a **📍 No location** tag on any open order whose shop still has no pin. Delivery screens already handled missing pins and are unchanged. |
| Save functions | `submitOrderWithVisit` (`src/visits.js`) and `submitOrderAsManager` (`src/managerOrders.js`) no longer refuse an unpinned customer. They copy a valid pin exactly; otherwise they store `customerLat`/`customerLng` = `null`. No coordinates are ever invented. The customer record is not changed. |
| Rules | `orderBodyOk` → `orderPinOk`. If the customer has a valid pin, the order must copy it exactly. If not, the order must carry null coordinates. Invented, partial or malformed coordinates are refused. |
| Unchanged | **Creating** a customer still requires a valid pin, and removing an existing pin is still refused. Inactive and merging customers are still refused. |

## 2. The schedule refreshes immediately after every change

After **any** schedule change, `refreshWeeklySchedule()` reloads the saved plan (customers) **and** the dated schedule history (`loadPlanAndHistory`), then redraws the Weekly Schedule, the awaiting list and the customer table. Changes covered:

- a board edit
- an "Awaiting a visit day" assignment
- a spreadsheet import
- a distance suggestion
- deactivate / reactivate
- a merge

An open Rep Performance report is re-run as well.

On the rep side, Today's Visits reloads when the rep returns to the app and the list is more than a minute old, as well as when it is reopened. Browser checks E62 and E63 confirm that the board updates at once and that the rep's daily list matches the board for today.

## 3. No misleading performance figures

`src/weekBoard.js` was rewritten.

- **Days measured only against dated history.** Past days and today are measured only against the plan that applied that day (`targetsForDate`). With no reliable history, a day shows **"History unavailable"**. The causes are: history not started, history began later, or history failed to load. Such a day has no Missed, no Due and no coverage. Visits recorded that day are still listed and still count as orders or no-order visits. Today's plan is never used to judge the past.
- **Upcoming days.** These show the current plan as "Planned"; nothing is measured on them.
- **Legacy-merge ambiguity.** The same date-aware identity as the report is used (`visitIdentityAt`). A visit that cannot be attributed after a legacy merge is credited to no shop. The candidate shops are shown as **"Uncertain"** and excluded from Planned, Visited and Missed, exactly as in the report.
- **Failed loads.** If the visits fail to load, every started day shows **"Data unavailable"** and the KPIs show "— unavailable", never 0. If the history fails to load, the days show "History unavailable". Rep Performance shows a persistent **"Data unavailable"** box and empties its tables when nothing could be loaded. If an earlier report is still on screen, it is labelled as being for its own dates. Today's Visits shows "—" instead of 0 when the rep's visits fail to load.
- **Board and report agree.** For one rep, the board's Scheduled, Visited, Still due, Orders, No order and coverage equal `buildPerformanceReport` for the same rep and dates. Unit tests B4 and B5 check this, as does browser check E61. With "All reps", the board labels the figure "Visited (any rep)".

## 4. Expense restriction completed

- **Rep screen.** A rep's list, edit options, summary tiles and totals contain only **his own Transport, Meals and Other**. His older Fuel and Stock Purchase records are never shown or totalled. RC6.2's "older record" tile and edit option are removed.
- **Query.** `fetchMyExpensesPage` filters `createdBy == uid` **and** `category in [Transport, Meals, Other]`. This needs a **new composite index**: `expenses (createdBy ASC, category ASC, date DESC)`, added to `firestore.indexes.json`.
- **Rules.** A rep can create, read and update only his own Transport/Meals/Other expenses. He cannot move a record into Fuel or Stock, or read his own older Fuel or Stock records.
- **Delivery person.** Unchanged: he can create, read and edit his own Fuel, Transport, Meals and Other expenses.
- **Manager.** Unchanged: reads and edits everything. Historical records are kept, never deleted or recategorised.
- **Note.** A user who is in **both** the submitters and deliverers lists is treated as a rep.

## 5. Trustworthy location-capture attribution

RC6.2's freely editable `pinnedBy` / `pinnedAt` fields are replaced by a validated **first-capture stamp**: `firstPinnedBy`, `firstPinnedByEmail` and `firstPinnedAt`.

- **When it is written.** The stamp is written when a customer is **created** with a pin (the same credit as pinning later). It is also written by `updateCustomerLocation` the first time an unpinned customer is pinned. That is a transaction that stamps only if the customer had no valid pin and no stamp.
- **What the rules enforce.**
  - The stamp must use the caller's own uid and email and the request time.
  - It must come together with a valid pin.
  - On an update, it can only be written if the customer had no valid pin and no stamp before.
  - It can **never be changed or removed**. A later re-pin cannot move credit into another week, and a customer pinned before RC6.3 cannot be stamped later.
- **How the figure is shown.** The board shows "N captured this week **(info only)**". It is **not** part of coverage or any performance percentage. Customers pinned before RC6.3 have no stamp and are not counted.

## 6. Verification (actual results; logs in the evidence pack)

Environment: Linux sandbox, **Node v24.22.0**, npm 10.9.4, Java 21. **Clean `npm ci`** with lifecycle scripts in the root and in `tests`: both exit 0.

| Check | Result |
|---|---|
| Root `npm ci` / tests `npm ci` (scripts run) | **PASS** / **PASS** |
| Complete mocked unit suite (`npx vitest run --config vitest.config.mjs --configLoader native`) | **31 files, 650 passed, 0 failed, 0 skipped** (`unit-full.log`) |
| Complete mocked browser suite (`npm run test:e2e`, one process, real Chromium) | **68 checks passed, 0 failed**: visits E1–E25, decisions E26–E55, RC6.3 E56–E69 (`e2e-full.log`) |
| Production build (`npm run build`) | **PASS**. `dist/build-id.txt` = RC6.3. The existing large-bundle warning remains. |
| New regression tests run against **RC6.2** source | **21 of 25 fail** there (the 4 controls pass). This shows the tests catch the RC6.2 defects (`rc63-tests-against-RC6.2-source.log`). |
| **Real Firestore emulator rules suite** (`npm run test:rules`), including RC6-MAX 12-line transactions, maintenance freeze, and the new RC6.3-ORD / RC6.3-EXP / RC6.3-PIN groups | **BLOCKED.** The emulator download is refused: `download failed, status 403: request blocked ... storage.googleapis.com` (`rules.log`). The tests are written and syntax-checked but **not executed**. |
| Real Auth/Firestore browser workflow against the emulator | **BLOCKED** (same cause) |
| Index acceptance on a real project | **NOT RUN** |

New regression tests:

- **`tests/unit/rc63.test.js`** (25 tests)
  - A: orders without a pin, for the rep and manager paths, with retry and controls
  - B1–B6: the board, history unavailable, failed loads, legacy-merge ambiguity, agreement with Rep Performance, the location metric
  - C: expense ownership, categories and pagination
  - D: first-capture attribution
- **`tests/e2e/rc63.e2e.mjs`** (E56–E69, 14 checks)
  - E56: rep expenses
  - E57: order without a pin, including a double tap
  - E58: first capture, and a re-pin keeping the stamp
  - E59: a rep's tabs
  - E66: the "No location" flag
  - E60: the board
  - E61: board = report for each rep
  - E62: immediate refresh after a board edit, an awaiting assignment, an import and a suggestion
  - E63: the rep's list matches the board
  - E64: failed visit, history and report loads
  - E65: history never started
  - E67: week navigation
  - E68: manager expenses and history
  - E69: no JavaScript errors
- **`tests/rules/invoicing.rules.test.js`**: new groups RC6.3-ORD, RC6.3-EXP and RC6.3-PIN. **Not executed.**

Stock, invoice numbering, retries and 12-line orders (mocked backend, all passing):

| Test file | Tests | Covers |
|---|---|---|
| `stock.test.js` | 14 | stock |
| `stockIdentity.test.js` | 15 | stock identity |
| `conversion.test.js` | 39 | stock conversion |
| `invoicing.test.js` | 24 | one invoice per order, retries, lock, standalone idempotency |
| `invoiceFlow.test.js` | 3 | invoice flow |
| `orderLines.test.js` | 27 | includes the 12-line cap |
| `priceApprovalRc61.test.js` | 10 | price approval |
| `decisions.test.js` | 71 | numbering adjustments, manager orders, retries, double clicks |
| `visits.test.js` | 42 | atomic order and visit, retries |

The **real-rules** versions of these checks (including RC6-MAX 12-line approval, invoice and cancellation transactions) are in the BLOCKED emulator suite. They must be run.

### Existing tests changed (disclosed)

1. **`unit/visits.test.js`**: the "un-pinned customer refused" assertion was removed. This is the owner decision; the new behaviour is tested in `rc63.test.js` A.
2. **`unit/decisions.test.js`**: the "unpinned customer refused" assertion for manager orders was removed, for the same reason. The inactive and merging checks are kept.
3. **`unit/maintenance.test.js`**: the build id and version are now RC6.3 / 6.3.0-rc1. The "rules unchanged from RC5" hash assertion is replaced: the rules must differ from the RC5 hash and match `rules/RC6.3-RULES-SHA256.txt`.
4. **`unit/rc62.test.js`**: removed and superseded by `rc63.test.js`. Its RC6.2 expectations (an older Fuel tile, the current plan used for past days) were the defects being fixed.
5. **`e2e/decisions.e2e.mjs` E54**: the malformed-amount fixture now uses category **Other** instead of Fuel, so the check still runs for both roles (a rep can no longer see Fuel). The assertions are unchanged.
6. **`e2e/rc62.e2e.mjs`**: renamed to **`rc63.e2e.mjs`** and rewritten for the corrected behaviour.
7. **`rules/invoicing.rules.test.js`**:
   - "order without a pin refused" is now "order that drops the pin of a PINNED customer refused".
   - The manager raw case is renamed in the same way.
   - The RC5-A expense fixtures use Transport for the rep, because Fuel is now refused for reps.
   - The RC6.3 groups are added.
8. **`tests/helpers/fakeFirestore.js` and `e2e/firestoreBrowser.js`**: an added `failQuery` test hook (failure injection only). The production code is not affected.

**Observed once.** In one earlier run during development, E36 (merge blocked while invoicing) failed with "lock should be released after a blocked merge". It passed on the two reruns and in the final full run. It looks like a timing-sensitive assertion in an existing RC6.1 test, in code RC6.3 does not touch, but it is recorded here.

## Before release (required)

1. On the developer's machine (Node ≥ 24.12, Java 21, emulator download working), from a fresh extraction:
   - `npm ci` (root and tests)
   - `npm test`
   - `npm run test:e2e`
   - `npm run build`
   - **`npm run test:rules`**

   All must pass with **zero failures and zero skips**. This includes the RC6.3-ORD, RC6.3-EXP and RC6.3-PIN groups, RC6-MAX and the maintenance freeze.
2. Run the real Auth/Firestore browser workflow against the emulator (RC6.1 review guide, part "Real Auth/Firestore browser workflow"), plus:
   - an order for an unpinned shop
   - a rep expense list with older Fuel records present
   - first-capture pinning
3. Complete backup/restore, preflight and owner sign-off as in RC6.1-OPERATIONS-PLAN.md, using **RC6.3** identifiers and the rules hash in `rules/RC6.3-RULES-SHA256.txt`.

## Coordinated rollout (rules + index + frontend)

The new rules **deny an old (RC6.1/RC6.2) rep client's expense list**, because the old query has no category filter. Run the steps in this order, inside a quiet window:

1. **Deploy the index first:** `firebase deploy --only firestore:indexes`. **Wait until the new `expenses (createdBy, category, date)` index shows READY** in the console.
2. Deploy hosting with build RC6.3. Confirm `/build-id.txt` = RC6.3.
3. Deploy the RC6.3 rules (`firebase deploy --only firestore:rules`). Confirm the deployed file's SHA-256 matches `rules/RC6.3-RULES-SHA256.txt`.
4. Ask every rep, manager and deliverer to **close and reopen the app, or hard-refresh**, and check that the screen shows **Build RC6.3**. Until he does, an old rep client will see "Could not load expenses" on the Expenses tab. Nothing is lost.
5. Run a pilot with one rep and one manager:
   - an order for an unpinned shop
   - the "No location" tag appears
   - a location is saved and the board shows "captured"
   - a visit day is moved and the board and the rep's list agree
   - the rep's expenses show only Transport, Meals and Other
6. Rollback: redeploy the previous rules and hosting together. Do not leave the RC6.3 rules with an RC6.1 client, or the reverse, for longer than the switch-over.

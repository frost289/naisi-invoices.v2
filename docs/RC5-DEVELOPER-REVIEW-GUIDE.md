> **RC6 NOTICE (SUPERSEDED-BY-RC6):** `docs/RC6-RELEASE-REPORT.md` and `docs/RC6-OPERATIONS-PLAN.md` win where they disagree with this document. Corrected: the stuck-Invoicing classifier (unsafe in RC5), the preflight now REQUIRES the product catalogue, and the RC5 statement that `custom:true` is mandatory on invoices (invoice rules keep a historical no-flag allowance; see RC6 report P3).

# RC5 developer review guide

## 1. Highest-risk changes (review in this order)
1. `rules/firestore.rules` — line functions `lineMoneyOk`, `lineTracked`, `lineCustom`, `lineValid`, `lineAt`, `linesSum`, `linesAndTotalOk(d, mode)`; `orderBodyOk` (catalogue mode), approve/edit/cancel-restore (order mode), invoices (invoice mode); `expenseAmountOk`. Unrolled 12 lines: **check expression count (<1000) and document-access limits** — never executed.
2. `src/stock.js` — approval/edit revalidation, `unknown-product`, `cancelOrder` recovery path (`recoverWithoutRestore`), `RECOVERY_REASON_PREFIX`.
3. `src/money.js`, `src/orderLines.js` — one currency/line policy (client and rules must match; unit test compares constants).
4. `src/main.js` — every formatted-currency sink wrapped in `esc()`; recovery checkbox in the cancel modal (DOM nodes, no innerHTML).
5. `src/scheduleHistory.js` `visitIdentityAt` — provenance-aware merge identity.
6. `tools/reconcile-logic.js` preflight; `tools/stuck-invoicing-logic.js`; `rules/maintenance-freeze.rules`.

## 2. Owner decisions
* Keep the 12-line cap (existing data check via preflight `maxLinesFound`).
* Expense amount policy (positive, <= MAX_EXPENSE, 2 decimals).
* Custom invoice lines need explicit `custom:true`; fractional quantity allowed only on custom lines.
* Recovery cancel + manual stock adjustment for malformed Approved orders.

## 3. Compatibility / migration
Stale RC4 tabs may be denied on custom lines until refreshed (freeze + refresh procedure in the rollout guide). No data is rewritten by RC5. Run the read-only preflight on a real export first.

## 4. Reproducing the blocked checks (Node >= 24.12, Java 21, firebase-tools; emulator jar downloadable)
```
npm ci && (cd tests && npm ci)
cd tests && npm run test:rules                # emulators:exec; ALL tests incl. RC5-A, RC5-B, RC5-B2 must pass, zero skipped
npm run test:e2e                              # mock-backed browser suite, single process only
```
Acceptance: rules suite 0 failures, 0 skipped, run against `rules/firestore.rules` whose SHA-256 equals HASHES.txt; the emulator log must show rules compiled with no warnings; the 12-line approve/edit/invoice/cancel batches succeed at maximum size (if "exceeded maximum" appears, lower `MAX_ORDER_LINES` in `src/money.js`, rules and tests together). Browser flows on real Auth + Firestore emulators (`run-app-on-emulators.bat`, `tools/seed-emulator.mjs`): sign in as manager, rep, deliverer; create/approve/edit/cancel/invoice/deliver; open Expenses with a seeded malicious amount (shows `Invalid amount`, no element created).
Also test the freeze: deploy `rules/maintenance-freeze.rules` to the emulator (`firebase.freeze.json`); every write must be denied, manager reads allowed, others denied.

## 5. Mocked vs real
Unit and existing browser suites use in-memory backends: they prove application logic, not Firebase rules, SDK behavior, or limits.

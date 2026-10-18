# RC4: fixes for the seven independent-review findings

Release id: **RC4** (2026-10-18). Branch `claude/fixes-oct-2026`. The review text file (`NAISI-RC3-Updated-Review.txt`) was not attached; the findings were taken from the task prompt. Each finding was reproduced with a test that FAILS on the RC3 source (log: `evidence/fail-on-original-RC3.log`) and PASSES on RC4.

Authoritative status: `docs/RC4-RELEASE-REPORT.md`. Where this file or any older report disagrees with it, the release report wins.

## 1. Stored HTML / script injection
- Defect: customer, product, order, invoice, expense, visit and error text was concatenated into `innerHTML` templates (toast, item rows, preview, tables, suggestions, shortages, map links).
- Fix: toast / button loading / preview / item inputs use DOM nodes, `textContent` and `.value`. Remaining templates escape every interpolation with `esc()` (quotes, `&`, `<`, `>`), except a short allowlist of helpers that themselves return escaped HTML. Legitimate punctuation (`O'Brien & Sons "Best" <Shop>`) displays correctly.
- Files: `src/ui.js`, `src/preview.js`, `src/items.js`, `src/bulkProgress.js`, `src/main.js`.
- Tests: `tests/unit/htmlSafety.test.js` (static audit of every `src/*.js` template plus a ban on `insertAdjacentHTML` / `outerHTML` / `document.write`; jsdom tests with hostile strings); browser check E53 in `tests/e2e/decisions.e2e.mjs` (malicious saved customer, product, order, invoice, expense and visit; a manager browses every tab; nothing executes).

## 2. Order lifecycle and invoicing locks
- Defect: a manager write to an order was only loosely constrained. An Invoiced/Delivered order could be set back to Approved and then cancelled; a stale invoicing attempt could release or complete a newer one.
- Fix (rules, `rules/firestore.rules`, function `managerOrderWriteOk`): an explicit transition table (old status, new status, the only fields allowed):

| From | To | Fields allowed |
|---|---|---|
| Submitted | Approved | status, stockApplied=true, approvedAt, updatedAt; stored lines must be valid |
| Submitted | Rejected | status, rejectedAt, managerNotes, updatedAt |
| Submitted / Approved | Cancelled | cancellation entry (reason, actor, server time, once-only record; stock restore only with valid lines) |
| Approved | Invoicing | status, invoicingAttempt, invoicingLeaseStartedAt (server time), updatedAt |
| Invoicing | Invoicing | same, only after the 10-minute lease expired (take-over) |
| Invoicing | Approved | release: lock fields cleared AND `invoicingAttemptEnded` equals the holder's token |
| Invoicing | Invoiced | invoice created in the same commit AND `invoicingAttemptEnded` equals the holder's token |
| Submitted / Approved | same | edit: customer details, notes, items, grandTotal, updatedAt (valid lines) |
| any | same | merge move: customer fields only, never an Invoicing order |
| Invoiced | Delivered / failed delivery | deliverer rules (unchanged) |

  No row leaves Invoiced, Delivered, Rejected or Cancelled. orderNo, createdBy, invoiceId, invoiceNo, stockApplied and totals are not editable except as listed.
- Smallest protocol change: a new field `invoicingAttemptEnded` is written together with the lock being cleared. The rules compare it with the stored `invoicingAttempt`, so only the CURRENT holder can end the attempt. `src/orders.js` (`revertInvoiceGeneration`, `commitInvoice`) writes it.
- Tests: `tests/unit/invoicing.test.js` (token written, stale attempt cannot commit/release); `tests/rules/invoicing.rules.test.js` group RC4-H (emulator; NOT executed here, see report).

## 3. Trusted validation of order lines and money
- Approach chosen: a **rule-validatable bounded schema** (not a server function): the project has no backend and adding Cloud Functions would add a paid service, deployment and a new trust boundary. Rules have no loops, so orders are limited to **1 to 12 lines**, checked by an unrolled function (`lineOk` / `linesAndTotalOk`). The 12-line cap is a new business limit; the UI says "Split it into two orders".
- Policy: MWK, 2 decimals; line total = qty x price rounded to 2 decimals; order total = sum of line totals; tolerance 0.01. qty > 0 (<= 1,000,000), price >= 0. A line with `productId` is stock-tracked: whole-number qty. A line without `productId` is a custom line: fractional qty allowed, never stock-tracked.
- Client defense in depth (`src/orderLines.js`, `src/stock.js`): the STORED order is re-validated before approval, before an edit of an Approved order, and before a cancellation that would restore stock. Approval refuses a line whose product no longer exists. A negative quantity can never raise stock. Cancelling a Submitted order with bad lines is still allowed (no stock involved).
- Rules enforce the same schema on order create, edit, approval, cancellation-with-restore, and stand-alone / edited invoices.
- Not changed (business decision): an order's invoice may still differ from its order lines (only internal consistency is enforced).
- Tests: `tests/unit/orderLines.test.js`; rules group RC4-I (emulator, not executed here).

## 4. Historical reporting after customer merges
- Defect: `mergeCustomers` rewrote visit `customerId`, so a merge today changed earlier days' coverage and targets.
- Fix: a merge stamps `originalCustomerId` (set once) on each moved visit and marks the merge record `visitsKeepOriginal: true`. Identity is date-aware: a visit's shop on a date = its original shop followed through merges that had happened by that date. A merge is dated; before the merge day both shops are separate targets.
- Existing (legacy) merges: visits moved before RC4 carry no original id. A visit made before a legacy merge that moved visits and now points at the survivor is **AMBIGUOUS**: it is credited to no shop and is listed in the report (`ambiguousVisits`). Nothing is invented. A legacy merge that moved 0 visits is not ambiguous.
- Files: `src/scheduleHistory.js`, `src/visitSchedule.js`, `src/customers.js`, rules for visits / customerMerges.
- Tests: `tests/unit/mergeHistory.test.js`; three older decisions tests encoded the defect (retroactive merge) and were updated (disclosed in the report).

## 5. Stock reconciliation
- Defect: cancellation restorations were compared in total, so p1=2 / p2=3 expected vs p1=5 / p2=0 actual looked fine.
- Fix: `tools/reconcile-logic.js` compares expected and actual per orderId AND productId and flags missing, unexpected, duplicated and incorrect movements, plus unattributed movements. Result status is `CLEAN | FINDINGS | INCOMPLETE`; missing inputs give INCOMPLETE (never "safe"); exit codes 0 / 1 / 3; still read-only. `--products` supplies the product list.
- Tests: `tests/unit/reconcile.test.js` (includes the exact p1/p2 case).

## 6. Deployment configuration
- Defect: `firebase.json` referenced a rules file that did not exist; deployment and emulator tests could use different files.
- Fix: one rules file `rules/firestore.rules`, referenced by `firebase.json` and `firebase.emulators.json`; rules tests default to it; `firestore.indexes.json` added and referenced by both. Docs / bat files updated.
- Tests: `tests/unit/deployConfig.test.js` (files exist, same path, balanced braces, every called function defined, indexes valid). This is a static lint; it does not replace the emulator, which can compile the rules (BLOCKED here).

## 7. Conflicting spreadsheet imports
- Defect: conflicts were detected before manual choices were applied, so a manual choice could push one customer onto two days.
- Fix (`src/scheduleImport.js`): resolve each row to a customer id (automatic, manual, or already-conflicting) -> group by id -> if a customer has more than one day, every row of that customer is blocked -> only then build moves. Checkboxes, stale protection, inactive / merging exclusions and dated history are unchanged; re-importing the same plan creates no moves ("already on").
- Tests: `tests/unit/scheduleImport.test.js` (manual/manual, manual/automatic, row-order independence, unrelated shops still move, re-import).

## Migration (nothing destructive; dry-run by default)
1. Deploy order: rules last, after staff refresh (see report). New clients write `invoicingAttemptEnded`; old clients do not and would be refused on release / invoice commit.
2. Existing `Invoicing` locks written by RC3 carry `invoicingAttempt` but no ended token: an RC4 client ending such a lock sends its token, so these work. A lock with no `invoicingAttempt` (pre-RC3) needs manual review (client already refuses it).
3. Orders with more than 12 lines or invalid stored lines: run `node tools/reconcile.mjs` (read-only) to list them; they can still be cancelled / rejected (Submitted) but cannot be approved or edited until fixed by a manager.
4. Legacy merges: ambiguous visits are reported, not rewritten.

## Rollback
Redeploy the RC3 rules file and the RC3 build TOGETHER (outside business hours; tell staff to refresh). No data is rewritten by RC4. Fields RC4 adds (`originalCustomerId` on merged visits, `invoicingAttemptEnded` on orders, `visitsKeepOriginal` on merge records) stay in the documents; RC3 rules only look at the keys a write changes, so they do not block later writes. After a rollback the date-aware merge history is no longer applied by the client. An order left in `Invoicing` at the moment of the swap is released by the RC3 client after its 10-minute lease.

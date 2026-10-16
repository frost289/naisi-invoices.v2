# RC3: how the eight owner decisions were implemented

Status: implemented and unit/browser tested. The Firestore RULES that enforce them have NOT been executed on an emulator by the developer (the emulator could not be downloaded in the build environment, HTTP 403). Independent QA must run `run-rules-tests.bat` before any release.

| # | Decision | Where it is enforced |
|---|---|---|
| 1 | All reps share the daily schedule; managers alone schedule/deactivate; new customers wait unscheduled | Rules: customer create must have `assignedDay:null, active:true`; a schedule change needs a linked `scheduleChanges` entry and a manager. App: `src/customers.js`, `visitSchedule.js` (`awaitingScheduling`) |
| 2 | Manager cancellation, reason + actor + server time, stock restored once | `src/stock.js cancelOrder`; rules: `orderCancellations/{orderId}` is create-once (so a second restore is impossible), `Cancelled` is terminal, orders cannot be deleted. Invoiced/delivered orders cannot use this path (see CANCELLATION-AND-RETURNS.md) |
| 3 | Manager-entered orders | `src/managerOrders.js`; id `m_<uid>_<req>`; `source:'manager-entered'`, `enteredBy` separate from `repUid`; never a visit; reports show them separately |
| 4 | Walk-in invoices | `src/orders.js issueStandaloneInvoice`; id `sa_<uid>_<req>`; same counter; an identical retry returns the saved invoice, different details conflict |
| 5 | Depot removed | screen, navigation, reads and writes deleted; no `config/depot` permission anywhere; pins/maps/routing/delivery unchanged |
| 6 | Number control | automatic numbers; `src/numbering.js adjustInvoiceCounter` (reason required, audit in `counterAdjustments`); `invoiceNumbers/{no}` is create-once so an issued number can never be reused; adjustment and issue are mutually exclusive in one transaction/rule check |
| 7 | Historical performance | `config/scheduleHistory` + append-only `scheduleChanges`; see SCHEDULE-HISTORY.md |
| 8 | Merge vs invoicing | `mergeLock` on the customer + rule `orderMergeMoveOk` refuses to re-point an order that is in Invoicing; clear message `merge-blocked-invoicing`; no auto-queue |

## What rules can and cannot guarantee (honest list)
1. Rules cannot check that the stock quantities restored on cancellation are the right ones. Mitigation: `tools/reconcile.mjs` flags `CANCEL_STOCK_MISMATCH` and double restores. No Cloud Function was built; if the owner wants this guaranteed, a trusted server component is the next step.
2. The invoice-number YEAR is not verified by the rules (any four digits).
3. Baseline schedule entries are trusted from a manager during the first hour after the history is started.
4. A paused merge keeps its lock until resumed or cancelled (Customers screen). A stuck Invoicing order blocks merges until a manager resolves it.
5. A cancelled order's visit still counts as an order taken that day.
6. Reps cannot see manager-entered orders (isolation preserved).
7. Rules lookup limits (10 per single request, 20 per batch) are respected by design (chunks of 8) but this is verified only by emulator group P, which has not been run.
8. Old manager clients must be refreshed before the rules are deployed (see DEPLOYMENT-AND-RULES.md).

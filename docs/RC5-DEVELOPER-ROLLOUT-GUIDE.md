> **RC6 NOTICE (SUPERSEDED-BY-RC6):** `docs/RC6-RELEASE-REPORT.md` and `docs/RC6-OPERATIONS-PLAN.md` win where they disagree with this document. Corrected: the stuck-Invoicing classifier (unsafe in RC5), the preflight now REQUIRES the product catalogue, and the RC5 statement that `custom:true` is mandatory on invoices (invoice rules keep a historical no-flag allowance; see RC6 report P3).

# RC5 developer-run rollout guide

Performed by the developer, with owner approval. **Nothing here was run against production by Claude.** Do not start until the blocked checks in the review guide have passed and the hashes in HASHES.txt match your files.

## 0. Preconditions
GitHub token reported in the RC4 report: confirm revoked; rotate. Fresh Firestore export taken and **restore tested** into a scratch project (open the restored copy, compare document counts for orders, invoices, invoiceNumbers, products, stockMovements, counters). Staff roster ready.

## 1. Read-only preflight (on the exported JSON, not the live database)
```
node tools/reconcile.mjs orders.json invoices.json --numbers invoiceNumbers.json --counter counter.json --stock stockMovements.json --cancellations orderCancellations.json --customers customers.json --schedule schedule.json --history scheduleHistory.json --products products.json
node tools/migrate-rc3.mjs --files <folder>
```
Read three separate fields: `completeness` (COMPLETE needed), `dataReadiness` (READY needed), `releaseReadiness` (always not assessed: this is NOT approval). Review `preflight.maxLinesFound` and oversized orders for the owner's 12-line decision. Handle each listed malformed record: Submitted -> reject/cancel in the app; Approved -> section 5.

## 2. Deployment order (freeze first, because old tabs and new rules disagree briefly)
1. Announce a window outside business hours. 
2. **Freeze:** `firebase deploy --only firestore:rules --config firebase.freeze.json` (rules/maintenance-freeze.rules: no writes, manager reads only). Staff see "permission denied" on save; nothing is half-written. Confirm a test write fails.
3. Deploy indexes: `firebase deploy --only firestore:indexes` (wait until the console shows them built).
4. Build and deploy hosting: `npm ci && npm run build`; check `dist/build-id.txt` says RC5 and `dist` was built from the hashed source; `firebase deploy --only hosting`.
5. Open the site in a fresh window: bottom-right shows **Build RC5**. Staff must hard-refresh (Ctrl+F5) or close and reopen the tab; anyone who sees an older build id must refresh before step 6.
6. **Unfreeze:** `firebase deploy --only firestore:rules` (default config = rules/firestore.rules); compare its SHA-256 with HASHES.txt.
Staff access during the window is controlled by the freeze: they cannot write until the new build and rules are both live.

## 3. Pilot
Two to three users (one manager, one rep, one deliverer) for 2 working days. Success: orders approve with correct stock movements; one invoice per order; expenses add; no `permission-denied` for legitimate actions; Build RC5 visible; daily reconcile on a fresh export = COMPLETE + READY. Failure/stop: any invoice duplicated or missing, stock mismatch, unexplained permission-denied for a valid action, any order stuck in Invoicing, any non-RC5 build in use. On stop: freeze (step 2), investigate.

## 4. Monitoring
Daily: reconcile on a fresh export; `node tools/stuck-invoicing.mjs orders.json invoices.json invoiceNumbers.json` (exit 1 = something stuck); Firebase console usage and denied-requests graph; spot check 5 invoices against orders.

## 5. Recovery and fallback (no silent return to known vulnerabilities)
* **Default fallback = freeze**, not an older release. Deploy `firebase.freeze.json`, fix forward, redeploy RC5. Reverting to RC3 or RC4 re-opens known holes (HTML injection, untracked stock lines) and needs a separate documented owner decision and a data check first.
* **Orders stuck in Invoicing (release interrupted).** `INVOICING_RESUME_ENABLED=false`: **no automatic recovery exists; the ten-minute lease is not a recovery.** Procedure: freeze; export orders, invoices, invoiceNumbers; run `tools/stuck-invoicing.mjs`. `SAFE_TO_RELEASE` (no invoice, no registered number): an authorised developer sets the order back to Approved and removes `invoicingAttempt` and `invoicingLeaseStartedAt` in the console, then re-runs the tool. `ALREADY_INVOICED` or `NEEDS_REVIEW`: do not edit; resolve with the owner. Unfreeze afterwards.
* **Approved order with malformed lines.** Preflight lists it. Manager opens the order, Cancel, tick the recovery box that appears after the normal cancel is refused, give the reason. The order becomes Cancelled with a RECOVERY reason and actor, no stock movement is written. Using the stock ledger the owner decides the true quantities and makes an audited manual stock adjustment that names the order number. The app never guesses the stock.
* **Restore data** only from the tested backup, only with owner approval, with writes frozen.

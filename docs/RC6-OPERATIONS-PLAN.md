# RC6 operations plan — Monday 19 October 2026 (Africa/Blantyre, CAT = UTC+2)
Developer-run. Supersedes `RC5-DEVELOPER-ROLLOUT-GUIDE.md`. **Nothing here has been run against production. RC6 is NOT APPROVED FOR PRODUCTION until Outcome A below is fully met.**

## Decide first (tonight, before any staff start)
Is every item in the Outcome A gate list true and recorded? **Yes -> Outcome A. Anything no, unrun or unapproved -> Outcome B.** A missed deadline is never a reason to deploy: the unrun checks are the ones that prove the rules.

## Outcome A — all gates met
Gate list (all must be YES, with the evidence kept):
1. Developer has reviewed the RC6 changes and report. 
2. `npm run test:rules` on a machine with working emulators: exit 0, 0 failed, 0 skipped, rules compiled with no warnings (includes RC6-MAX 12-line and freeze tests). 
3. Real-emulator browser walk of the rep and manager flow completed (review guide section 4). 
4. Backup taken AND restored into a scratch project; counts compared (orders, invoices, invoiceNumbers, products, stockMovements, counters, customers).
5. Read-only preflight on a representative export: `node tools/reconcile.mjs orders.json invoices.json --numbers invoiceNumbers.json --counter counter.json --stock stockMovements.json --cancellations orderCancellations.json --customers customers.json --schedule scheduleChanges.json --history scheduleHistory.json --products products.json` -> `completeness COMPLETE`, `dataReadiness READY`; and `node tools/migrate-rc3.mjs --files <folder>` (include `products.json`) -> not INCOMPLETE/BLOCKED. Remember: READY is not release approval. Record `maxLinesFound`.
6. Owner has accepted: the 12-line cap, the expense-amount policy, the recovery procedure, the custom-line behaviour (report P3).
7. GitHub token revoked (developer confirms).
Deployment (outside business hours, order matters):
1. **Freeze:** `firebase deploy --only firestore:rules --config firebase.freeze.json` (rules/maintenance-freeze.rules). Verify one write is denied. 
2. If any order is in Invoicing: export orders/invoices/invoiceNumbers AFTER the freeze and run `node tools/stuck-invoicing.mjs orders.json invoices.json invoiceNumbers.json --frozen-at <ISO time of freeze> --exported-at <ISO time of export>`. Act only on `SAFE_TO_RELEASE` (steps printed); `ALREADY_INVOICED` / `NEEDS_REVIEW`: do not edit anything, resolve with the owner. Re-export and re-run: nothing may remain unreviewed.
3. `firebase deploy --only firestore:indexes`; wait until built.
4. `npm ci && npm run build`; check `dist/build-id.txt` = RC6; `firebase deploy --only hosting`.
5. Open the site in a fresh window: bottom-right shows **Build RC6**.
6. **Unfreeze:** `firebase deploy --only firestore:rules` (rules/firestore.rules); `sha256sum rules/firestore.rules` equals HASHES.txt.
7. Every participating device: close the tab or hard-refresh (Ctrl+F5); read the build id aloud/with a photo to the developer; anything not RC6 is not used.
Supervised start-of-day pilot (one rep, one manager, developer present):
* Rep: sign in, open today's schedule, record one visit with no order, one with an order (catalogue products). 
* Manager: approve the order -> stock reduced once; invoice it -> exactly one invoice; deliverer updates delivery; add one expense (valid) and confirm an invalid one is refused.
* Success: all of the above correct; no permission-denied for a legitimate action; stock and invoice counts match the paper note kept by the developer; preflight/reconcile on a fresh export still COMPLETE/READY.
* Stop conditions (freeze immediately): a duplicated or missing invoice, a stock mismatch, a permission-denied on a valid action, an order stuck in Invoicing, any device on a build that is not RC6, any unexplained write.
Recovery / fallback (never a return to RC3 or RC4): freeze (step 1), fix forward, redeploy RC6. Orders stuck in Invoicing: step 2. Approved orders with malformed lines: the recovery cancel + audited manual stock adjustment (preflight lists them with the ledger amounts). Data restore only from the tested backup, with the owner's approval, with writes frozen. A return to an older release needs a separate owner decision and a data check, because older releases contain known defects.

## Outcome B — required verification or approval incomplete (the expected case unless the emulator checks are run tonight)
**Do not deploy RC6.** Choose, with the developer, one of:
**B1. Use the version that is live now** (the developer states exactly which build/commit is live; as far as the repository shows, `main` predates every RC3–RC6 fix). The developer must judge this acceptable. Start-of-day checklist for the rep:
1. Sign in; if the app shows a build id, note it. Do not refresh to or open any other URL or version.
2. Use only: today's customer schedule, record visits with outcomes, submit orders from the product list (no free-typed products).
3. Do not use expenses free text beyond short plain words; do not paste anything into notes.
4. Each order submitted: write its order number on the daily sheet (below). One submission per order; if the screen hangs, do NOT resubmit: check Orders first, ask the manager.
5. End of day: manager compares the sheet to the app.
Manager: approve orders in the normal way, issue each invoice once, never retry an invoice that is stuck in "Invoicing" (tell the developer).
What the rep CAN use: schedule, visits, order submission. What stays UNAVAILABLE: anything added in RC3–RC6 (their protections, build id, new stuck-order and preflight tools). The developer should say tonight whether anything else is affected.
**B2. Manual fallback (if the developer finds B1 unsuitable)** — owner-approved paper/Excel capture:
* Numbering: every manual record gets `MAN-<rep initials>-<yyyymmdd>-<nn>` (e.g. MAN-TK-20261019-01), numbered in sequence, never reused; separate sheets for **Visits** (customer, time, outcome, reason if no order) and **Orders** (MAN number, customer, products, quantities, agreed prices, total). No invoice is issued from a manual record.
* Photograph or send the sheet to the manager at day end; the manager keeps the originals.
* Later reconciliation (after an approved deployment): enter each MAN order into the app ONCE, putting the MAN number in the order notes, and tick it off in a register kept by the manager; before entering, search the app for that customer and date to avoid a duplicate; invoices are issued only from the app order, so each sale gets one invoice.
* Orders taken manually are not stock-reserved in the app until entered: the manager keeps a running list so the same stock is not promised twice.

## Actions before the rep starts tomorrow
Developer: decide A or B tonight; run the blocked checks if A is to be possible; confirm token revocation; confirm which build is live; take and test the backup. Owner: accept or reject the four decisions; approve the chosen outcome and the manual fallback; tell the rep which outcome applies and who to call.

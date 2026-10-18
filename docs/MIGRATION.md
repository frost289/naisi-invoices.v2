> **RC5 NOTICE (SUPERSEDED-BY-RC5):** where this document disagrees with `docs/RC5-RELEASE-REPORT.md`, the RC5 report wins. In particular: there is NO rollback to RC3 and NO automatic ten-minute invoicing recovery (INVOICING_RESUME_ENABLED=false); use the freeze and stuck-Invoicing procedures in `docs/RC5-DEVELOPER-ROLLOUT-GUIDE.md`. Reconcile/migration preflight now reports invalid and oversized orders (RC4 notes claiming this were wrong at the time).

# Moving existing (legacy) data to RC3

Order: (1) back up (see RELEASE-CHECKLIST.md); (2) export `orders`, `invoices`, `invoiceNumbers`, `orderCancellations`, `counters/naisiInvoice`, `config/scheduleHistory` as JSON; (3) dry run:

`node tools/migrate-rc3.mjs --files <folder-with-the-json-files>`

and `node tools/reconcile.mjs orders.json invoices.json --numbers invoiceNumbers.json --counter counter.json ...` (read-only).

The migration planner is additive and invents nothing:
* **REGISTER_NUMBER**: creates the `invoiceNumbers/<no>` entry for each old invoice number (needed so an old number can never be reissued). Duplicated numbers are NOT registered; they are reported.
* **LABEL_KIND**: sets `kind:'order'` only on invoices an order demonstrably points to. Others are reported for a person.
* Reported only: old cancelled orders (no reason/actor exists and none is made up), a counter that would reuse a number (fix in the app, Numbering, with a reason), and a schedule history that is not started (a manager starts it in the app so the server clock is used).

The tool runs against the local emulator (`--apply` writes there only) or on JSON files. It refuses non-local hosts. **Writing the registry requires admin rights** (the rules forbid clients from backfilling it), so a live run is an owner-authorised action by someone with Firebase admin access; it is not part of this delivery and was never run live.
Tested on fake data only: `tests/unit/migrate.test.js`, plus the dry run in the evidence pack. The emulator `--apply` path was NOT run here (no emulator).

## RC5 additions
`reconcile.mjs` now checks every order and invoice for quantities, product identity, line totals, aggregate totals and the 12-line cap, and reports ids, statuses, reasons and recovery. Read `completeness`, `dataReadiness` and `releaseReadiness` separately: a clean data check is not release approval. Recovery of Approved malformed orders: docs/RC5-DEVELOPER-ROLLOUT-GUIDE.md section 5.

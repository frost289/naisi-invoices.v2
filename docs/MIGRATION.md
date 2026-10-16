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

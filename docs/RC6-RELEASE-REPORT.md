# Naisi Foods invoicing app — RC6 release report (authoritative)

> ## REAL FIREBASE VERIFICATION INCOMPLETE — NOT APPROVED FOR PRODUCTION
> The Firestore rules suite, real rules compilation, the maximum-size and freeze rules tests, and the browser workflows on real Auth + Firestore emulators have **not been run**: the emulator download is blocked in the authoring environment (HTTP 403). Nothing was deployed. This report supersedes RC5 where they differ (section 6).

Build identifier **RC6** (bottom-right of every screen, `public/build-id.txt`, `/build-id.txt` after deployment). Package version `6.0.0-rc6`. Hashes: `HASHES.txt` (outside the archives).
Input verified: the RC5 app ZIP, evidence ZIP and `rules/firestore.rules` (471a2419…0c0e32) matched the RC5 `HASHES.txt` before work started. RC6 changes the rules file **not at all** (the rules text is byte-identical to RC5); RC6 changes tools, one client validator, tests and documents.
`NAISI-RC5-Independent-Review.txt` (18 Oct 2026; RC5 app/evidence/rules hashes matched ours) was read. Its three findings (stuck-Invoicing classifier, preflight completeness without the catalogue, custom-invoice documentation) were each reproduced in code before fixing; the reviewer's Reproduction A and B are test scenarios 1 and 2 plus the duplicate-invoice test. Reviewer's score: engineering 8/10, production readiness 6/10 for RC5; we do not claim RC6 improves the unverified items.

## 1. What ran and what did not

| Check | Result | Backend |
|---|---|---|
| Regression-BEFORE: new RC6 tests on the untouched RC5 source | executed: **18 fail, 18 pass** (the passing ones are controls/consequence demonstrations) — `logs/regression-before-on-RC5.log` | mock |
| Clean install from lockfiles (root and tests) | see evidence `logs/npm-ci-*.log` | n/a |
| Full unit suite | see evidence `logs/unit-rc6*.log` | in-memory fake Firestore (MOCK) |
| Mock-backed browser suite | see evidence `logs/e2e-rc6*.log` | in-memory backend (MOCK) |
| Production build | see evidence `logs/build-rc6*.log` | n/a |
| Real rules compilation | **BLOCKED — NOT RUN** | emulator jar |
| Full Firestore rules suite (existing + RC5 adversarial + RC6-P3 + RC6-MAX) | **BLOCKED — NOT RUN** | emulator |
| Maximum-size (12 line) order, approve, edit, invoice, cancel transactions | **BLOCKED — NOT RUN** (test group `RC6-MAX` written) | emulator |
| Maintenance-freeze rules (writes denied, manager reads allowed) | **BLOCKED — NOT RUN** (`tests/rules/freeze.rules.test.js` written; only a static text check ran) | emulator |
| Browser workflows on real Auth + Firestore emulators | **BLOCKED — NOT RUN** | emulators |

Blocker detail: `npm run test:rules` -> `firebase emulators:exec` -> `Error: download failed, status 403: request blocked: no rule or allowlist entry allows host "storage.googleapis.com"` (log: `logs/rules-suite-BLOCKED.log`). Not bypassed. A static lint of the rules (balanced, functions defined) ran inside the unit suite; it is **not** compilation. Copy-paste commands and acceptance criteria: review guide section 4.

## 2. Findings

### P1. Unsafe stuck-Invoicing recovery — reproduced, fixed (`tools/stuck-invoicing-logic.js`, `tools/stuck-invoicing.mjs`)
* **Reproduced:** RC5 looked only at `invoice.orderId` and the id `ord_<orderId>`. A legacy invoice that the order points to (`order.invoiceId` / `order.invoiceNo`), that is in the number registry, or that is unlinked but identical, was invisible, so RC5 returned `SAFE_TO_RELEASE`. Test `RC6-P1 … the duplicate-invoice consequence` shows the result of following that advice on isolated data: after the manual release the app issues `ord_<id>` and **two invoices exist for one sale** (legacy + new). With RC6 the same data gives `NEEDS_REVIEW`, nothing is released, the app still refuses a second attempt, one invoice remains.
* **Fix:** the classifier now inspects order.invoiceId / invoiceNo, invoice.orderId, the deterministic id and the registry in both directions; detects missing targets, registry pointing elsewhere, invoice claimed by another order, several invoices; treats an unlinked invoice with the same customer, items and total as a **possible orphan** (`NEEDS_REVIEW`, never linked automatically, never proof). `SAFE_TO_RELEASE` is now only returned when all inputs are present and well-formed, **the export is confirmed taken after writes were frozen** (`--frozen-at`, `--exported-at`, export not before the freeze), and no invoice/pointer/registry entry/look-alike exists. Missing or malformed input -> `INPUTS_INCOMPLETE` for every order and exit code 3. Still read-only (no Firestore connection, no writes; test checks the input file is unchanged).
* **Tests** (`tests/unit/stuckInvoicing.test.js`, adjusted `maintenance.test.js`): the six required scenarios (explicit legacy link with registered number; unlinked matching legacy invoice; registered number to a missing invoice; conflicting links/multiple invoices; incomplete inputs; genuinely clean attempt), freeze confirmation, CLI exit codes (0/1/2/3), duplicate-invoice consequence and positive control (clean attempt is releasable and then invoices exactly once).
* **Limitations:** orphan matching is by customer name, items and total only, so a real orphan with an edited name/total is not detected — that is why the procedure also requires a person to look at Invoices before any release. The tool cannot see writes made after the export; hence the freeze requirement.

### P2. Preflight completeness — reproduced, fixed (`tools/reconcile-logic.js`, `tools/reconcile.mjs`, `tools/migrate-logic.js`, `tools/migrate-rc3.mjs`)
* **Reproduced:** with `--products` omitted, RC5 reported COMPLETE/READY/CLEAN although the product-identity check had not run; migrate-rc3 `--files` treated any missing export file as an empty collection and could print `ASSESSMENT: CLEAN`.
* **Fix:** the catalogue is a **required input** (`products`). Omitted -> `completeness INCOMPLETE`, `dataReadiness NOT_ASSESSED`, status INCOMPLETE, exit 3, the skipped check `products` named with what it covers. An explicitly supplied empty list is a real empty catalogue: every product reference is `UNKNOWN_PRODUCT` (open orders high -> data BLOCKED, historical info). A non-array is treated as not supplied (CLI: exit 2). `releaseReadiness` is always `NOT_ASSESSED_BY_THIS_TOOL`. The migration planner now takes `products` and `missingInputs`, adds `UNKNOWN_PRODUCT`, reports `INCOMPLETE` when any required export is missing, and the CLI prints that a CLEAN result is not release approval; the emulator path lists `products` too.
* **Tests:** `tests/unit/catalogue.test.js` (missing, empty, unknown, valid catalogue; existing malformed and oversized records still reported; migration planner; CLI exit codes for reconcile and migrate-rc3).
* **Limitations:** the check covers stock-tracked order lines only (invoices are historical). Export freshness is the operator's responsibility.

### P3. Custom-invoice documentation — the RC5 report was inaccurate; behaviour kept, documentation and one client mismatch fixed
Actual behaviour (verified in `src/orderLines.js` and `rules/firestore.rules`, now pinned by `tests/unit/customLinePolicy.test.js`):

| Where | Tracked (catalogue product) | `custom:true` | Historical line (no productId, no `custom` key) |
|---|---|---|---|
| Rep order / manager-entered order creation (catalogue-only) | yes | **no** | **no** |
| Order approve / edit / cancel-restore ("order" mode) | yes | yes | **no** |
| Invoice create / invoice line edit ("invoice" mode) | yes | yes | **yes — compatibility allowance** |

* New invoice and order lines built by the app always carry `custom:true` for non-catalogue rows (`src/items.js`). So the RC5 statement "custom:true is mandatory" was true for **orders** and for what the app writes, but **not** enforced for invoices: invoice rules deliberately still accept the historical no-flag line (old invoices stay editable; stale clients can still invoice). No schema change was made.
* Stale-client compatibility, stated accurately: a stale RC4 tab can still create invoices and rep orders (rep orders always carry a product). It can **not** edit/approve an order whose non-catalogue line lacks the flag. Legacy stored orders with such lines are reported by the preflight (`INVALID_ORDER_LINES`) and follow the recovery procedure.
* **Defect found while verifying:** the client validator in invoice mode accepted `custom:false` / `custom:"true"` on a line with no product, whereas the rules reject any line that has a `custom` key unless it is `true`. Fixed in `lineKind` (a non-`true` custom value is now invalid in every mode); test `malformed markers are rejected in every mode` (fails on RC5). No change to the rules.
* Emulator group `RC6-P3` (invoice line edits, five roles) is written, **not run**.

## 3. Release gates still open
1. Run the blocked checks (review guide section 4) with every result recorded.
2. Owner acceptance (the reviewer also asks whether the historical no-flag invoice line should be allowed only for old records or also for new invoice writes: RC6 keeps RC5's rules, which allow it for both, so stale clients keep working; tightening it later is a rules change that needs the emulator suite): 12-line cap (check `preflight.maxLinesFound` on the real export), expense-amount policy, recovery cancel + manual stock adjustment, custom-line behaviour in the table above.
3. Developer review of the rules (unchanged since RC5) and of this release.
4. GitHub credential: **developer must confirm the exposed token is revoked**. It was never printed or used.

## 4. Changes to existing tests (disclosed)
* `reconcile.test.js`: the shared fixtures `ALL` and `full` now include a product catalogue (`products: [{ id: 'p1' }]`) because the catalogue is a required input; the "orders + invoices only" assertion lists `products` among the skipped inputs. Assertions otherwise unchanged.
* `preflight.test.js`: the migration "CONTROL: valid data -> CLEAN" supplies the catalogue (required input).
* `maintenance.test.js`: stuck-Invoicing tests supply `--frozen-at`/`--exported-at` (a release is not recommended without them); build id and package version expectations are RC6 / 6.0.0-rc6; the "documented as default fallback" test reads the RC6 operations plan. The assertion "no automatic ten-minute recovery / no rollback to RC3" is kept.
* No test was deleted, skipped or loosened.

## 5. Not changed
Rules (byte-identical to RC5), the 12-line cap, stock/invoice/merge logic, workflows. All RC5 security and integrity fixes are retained.

## 6. Superseded RC5 statements
* "Custom invoice lines need explicit `custom:true` / stale RC4 tabs are denied on custom invoice lines" — withdrawn; see section P3.
* "`tools/stuck-invoicing` decides SAFE_TO_RELEASE from invoice.orderId and ord_ ids" — unsafe; replaced (P1).
* "reconcile COMPLETE/READY" without a catalogue — wrong; the catalogue is required (P2).
* RC5 rollout guide step 4 / monitoring commands: replaced by `docs/RC6-OPERATIONS-PLAN.md`.

## 7. Production deployment: NOT PERFORMED

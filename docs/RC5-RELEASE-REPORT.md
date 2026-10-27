> **RC6 NOTICE (SUPERSEDED-BY-RC6):** `docs/RC6-RELEASE-REPORT.md` and `docs/RC6-OPERATIONS-PLAN.md` win where they disagree with this document. Corrected: the stuck-Invoicing classifier (unsafe in RC5), the preflight now REQUIRES the product catalogue, and the RC5 statement that `custom:true` is mandatory on invoices (invoice rules keep a historical no-flag allowance; see RC6 report P3).

# Naisi Foods invoicing app — RC5 release report (authoritative)

**Status: NOT FULLY VERIFIED. Not approved for production. No deployment was performed.**
This report supersedes every earlier release claim (RC3/RC4 reports, VALIDATION-REPORT.md, REVIEW-RESPONSE.md, RC4-REVIEW-FIXES.md, RC4-RELEASE-REPORT.md) where they disagree with it. Specific corrections are listed in section 6.

Build identifier: **RC5** (shown bottom-right on every screen, `public/build-id.txt`, served as `/build-id.txt`). Package version `5.0.0-rc5`.
Input verified: RC4 app ZIP, evidence ZIP and `rules/firestore.rules` matched the supplied SHA-256 values (baseline commit `90c2b33` in the working copy). RC5 hashes are in `HASHES.txt` (outside the archives).

## 1. What could and could not be run

| Check | Result | Backend |
|---|---|---|
| Unit suite (Vitest) | executed, see evidence `logs/unit-rc5.log` | in-memory fake Firestore (MOCK) |
| Browser workflows (Playwright) | executed, `logs/e2e-rc5.log` | in-memory backend (MOCK) |
| Production build | executed, `logs/build-rc5.log` | n/a |
| Clean install from lockfiles | executed, `logs/npm-ci-*.log` | n/a |
| Firestore rules tests (existing + new RC5 adversarial) | **BLOCKED — not run** | needs real Firestore emulator |
| Real rules compilation | **BLOCKED — not run** | needs emulator jar |
| Browser flows on real Auth + Firestore emulators | **BLOCKED — not run** | needs emulators |
| Rules expression / document-access limits at 12 lines | **BLOCKED — not run** (test written) | needs emulator |

Blocker: the Firebase emulator jar download returns HTTP 403 from the sandbox (storage.googleapis.com), no mirror is reachable, and `@firebase/rules-unit-testing` 6 needs Node >= 24.12 (sandbox has 22). Nothing was bypassed. Developer commands are in the review guide section 4. **Every rules statement below is a static design claim until the rules suite has been run.**

## 2. Findings

Regression-before evidence: the new tests were copied onto the untouched RC4 source (`logs/regression-before-on-RC4.log`): **31 tests fail on RC4**, then pass on RC5 (`logs/unit-rc5.log`). Positive controls (legitimate workflows) are in the same files and pass on both.

### A. HTML injection through currency formatting — reproduced, fixed
* Reproduced: `mwk('<img src=x onerror=alert(1)>')` returned the string unchanged and the expense row/summary placed it in `innerHTML`; the static audit exempted `mwk`.
* Fix: `src/money.js` (`mwk` returns `Invalid amount` for any non-finite/non-number; `requireExpenseAmount` at the writer boundary; `summarizeExpenses` excludes malformed amounts from totals and lists them, never counts them as 0). Every `mwk/kmText/pctText/formatKm/googleMapsUrl` sink in `src/main.js`, `src/bulkProgress.js` is wrapped in `esc()`; the audit allow-list no longer exempts them (`tests/helpers/htmlAudit.js`). Reports (`src/reports.js`) and Excel export (`src/export.js`) flag `INVALID AMOUNT`. Rules: `expenseAmountOk` on expense create and update (`rules/firestore.rules`).
* Policy (owner to accept): expense amount must be a number, or a numeric string with up to 2 decimals, > 0 and <= MAX_EXPENSE (`src/money.js`).
* Tests: `tests/unit/money.test.js`, `htmlSafety.test.js`, browser `E54` (manager and rep views with a stored malicious amount; mock backend), rules group RC5-A (raw lower-privilege write rejected; legacy malformed record is read by a manager harmlessly) — **rules group not run**.
* Limitation: legacy malformed expenses already stored stay in the database; they are shown as `Invalid amount` and excluded from totals until a manager corrects them.

### B. Rep orders without stock identity — reproduced, fixed
* Reproduced: stock p1=10, Submitted order with `productId:null`: approval succeeded and stock stayed 10.
* Fix: line kinds in `src/orderLines.js` and `rules/firestore.rules` (`lineTracked`, `lineCustom`, `lineValid`): *tracked* (valid productId, whole-number quantity) and *custom* (explicit `custom:true`, no productId, fractional quantity allowed). Rep/manager order creation is **catalogue-only** (`mode 'catalogue'`): any line without a valid productId, or carrying `custom`, is rejected. Invoices (`mode 'invoice'`) keep freight/custom lines. Approval re-validates stored lines and refuses a product that does not exist (`unknown-product`) before moving any stock (`src/stock.js`). Product existence cannot be checked in rules without extra document reads, so it is enforced in the approval transaction.
* Tests: `tests/unit/stockIdentity.test.js` (missing, null, malformed, unknown, custom flag forged on a goods order, freight preserved), rules group RC5-B/B2 — **not run**.

### C. Mixed legacy + RC4 merges — reproduced, fixed
* Reproduced: legacy b->a (14 Oct), visit of 8 Oct, RC4 a->c (18 Oct) stamped `originalCustomerId=a`; `visitIdentityAt` returned a, ambiguous=false.
* Fix: `src/scheduleHistory.js` `visitIdentityAt` starts from the stamped original but always evaluates earlier legacy merges that moved visits without keeping origins, so the visit stays ambiguous (a or b). No origin is invented. New, repeated and chain merges unchanged.
* Tests: `tests/unit/mergeHistory.test.js` group RC5-C (failing on RC4, passing now; controls for ordinary chains).

### D. Migration preflight and legacy order recovery — reproduced, fixed
* Reproduced: with every input supplied, a negative-quantity Submitted order produced status CLEAN; 13-line orders were not reported.
* Fix: `tools/reconcile-logic.js` checks quantities, product identity, line totals, aggregate total and the 12-line cap for orders **and** invoices, reports id, status, reasons and recovery steps (`preflight` object, `INVALID_LINES` findings). Output now separates **completeness** (all inputs present), **dataReadiness** (RC5 can process the data) and **releaseReadiness** (always `NOT_ASSESSED_BY_THIS_TOOL`). The tool stays read-only. `tools/migrate-logic.js` surfaces the same assessment.
* Recovery for an already Approved malformed order (`src/stock.js` `cancelOrder` with `recoverWithoutRestore`): the normal cancel and edit paths still refuse it. The manager uses a clearly labelled recovery cancel: the order becomes Cancelled with a `RECOVERY:` reason and the actor, the cancellation record says `stockRestored:false`, **no stock movement is invented**. Stock is then corrected by an audited manual adjustment naming the order number, decided by a person from the ledger. Refused for valid orders and for Submitted orders. Idempotent on repeat clicks.
* Limitation: after a recovery cancel, reconcile cannot detect stock that was not restored; the manual adjustment is the control.
* Tests: `tests/unit/preflight.test.js`, `orderLines.test.js` (recovery group), `migrate.test.js`, `reconcile.test.js`.

## 3. Additional issues

1. **12-line cap** — not tightened. It already existed in RC4 (new in RC4 vs RC3). RC5 keeps it, documents it, and the preflight reports `maxLinesFound` and every oversized order/invoice from the exported data. **Owner acceptance required**; run the preflight on the real export before adopting it. The cap exists because rules cannot loop and the access/expression budget is unverified; lowering it is a one-constant change (`MAX_ORDER_LINES` in `src/money.js` and the unrolled rules) — **budget at 12 lines not verified here**.
2. **Currency policy** — one module (`src/money.js`, `src/orderLines.js`): line total = `round2(qty*price)`, tolerance 0.01 for line and aggregate, same formula in rules (`lineMoneyOk`, `linesAndTotalOk`). Boundary tests in `orderLines.test.js`/`money.test.js`. A constant-vs-rules comparison test checks the numbers match.
3. **Recovery / rollback** — see rollout guide. No default rollback to RC3. `INVOICING_RESUME_ENABLED=false`: **there is no automatic ten-minute recovery**; stuck orders are handled by `tools/stuck-invoicing.mjs` plus a manual, authorised step under freeze.
4. **Deployment artifacts** — tests (`tests/rules/invoicing.rules.test.js`), `firebase.json` and `firebase.emulators.json` all select `rules/firestore.rules`; `firebase.freeze.json` selects `rules/maintenance-freeze.rules`; indexes in `firestore.indexes.json`; build id RC5; unit test `maintenance.test.js` checks these agree. Hash of the rules file is in `HASHES.txt`. **Packaging hazard found:** `.gitignore` contains the pattern `firestore.rules`. When RC5 was rebuilt from the RC4 ZIP into a fresh git repository for testing, the rules file was silently left out of the export and the first clean-install run failed 4 tests. In the developer's existing repository the file is already tracked, so it is not affected; RC5 adds the negation `!rules/firestore.rules` so any fresh repository or export keeps it. Check that any new clone or ZIP you build contains `rules/firestore.rules` (its hash is in HASHES.txt).
5. **GitHub credential** — never printed or used. Revocation could not be established from any evidence: **developer must confirm it is revoked** and rotate any dependent access.

## 4. Changes to existing tests (disclosed)

* `orderLines.test.js`: existing custom-line fixtures now set `custom:true` (the explicit flag is the RC5 rule). Assertions unchanged.
* `migrate.test.js`, `reconcile.test.js`: fixtures given valid lines and consistent totals, because the preflight now (correctly) flags inconsistent fixtures. Assertions unchanged; one reconcile fixture total corrected.
* `htmlSafety.test.js` / `htmlAudit.js`: allow-list **narrowed** (mwk, kmText, pctText, googleMapsUrl removed from the exemptions) — stricter, not weaker.
* `mergeHistory.test.js`, `rules` suite: new groups appended; nothing removed or skipped.
* No test was deleted, skipped or loosened.

## 5. Compatibility notes

* RC5 rules require the explicit `custom:true` flag on custom invoice lines. A stale RC4 browser tab that still sends custom lines without the flag will be denied on save until refreshed. This is the main client/rules window; see rollout guide for the staff procedure.
* RC5 rules reject non-numeric expense amounts: stale clients that send them are denied (normal clients send numbers).
* Data written by RC4 (`originalCustomerId`, `invoicingAttemptEnded`, `visitsKeepOriginal`) is unchanged and still read.

## 6. Superseded claims

* "Reconcile lists orders with invalid or oversized lines" (RC4-REVIEW-FIXES) was false in RC4; true in RC5.
* "Roll back to RC3 rules + build together" and "an order left in Invoicing is released by the RC3 client after 10 minutes" — withdrawn: RC3 is known-vulnerable and resume is disabled, so no automatic release occurs.
* "mwk is safe HTML" — withdrawn.
* "398 unit tests / 52 browser checks" — counts are for RC4; RC5 counts are in the evidence logs.

## 7. Outstanding before production

Run the blocked checks (review guide section 4); owner decisions (section 3 items 1, 2 and expense policy); developer review; pilot. Production deployment: NOT PERFORMED.

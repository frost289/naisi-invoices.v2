# REAL FIREBASE VERIFICATION INCOMPLETE - NOT APPROVED FOR PRODUCTION

# RC6.1 release report

Build RC6.1, package version 6.1.0-rc1. Prepared 18 October 2026 for developer review. This is the authoritative RC6.1 report and supersedes RC6 documents where they differ. No production read, deployment, Firebase login or push was performed. Original input archives were not modified.

## Provenance and scope

The original application SHA-256 is `8d0e8583d14d8aefb7bf4b777105555959aaef121b11817a095519bd7e22efb7`; original evidence SHA-256 is `2fc0d37ff1ea7370b2ea770898d17f7d567a416cfab2ab0c773dbaf96c4707a7`. Both matched supplied HASHES.txt before implementation. Application rules remain byte-for-byte unchanged: `471a2419253581d9e8fe14b54e7db76009f1b53320e79b977875b0990c0c0e32`. No dependency was added or upgraded. The root package and lockfile versions and public build id changed; test dependency locks did not.

Evidence contains raw regression-before logs against untouched RC6, fix-after logs, command/version/exit-code records and source-file hashes. Native focused regressions use the actual functions and actual CLI modules with fake Firestore or a local fake HTTP server. They are not the complete Vitest suite and do not verify Firebase rules. Failed setup attempts are retained and labelled separately; they are not negative-test passes. The final verification summary in the evidence identifies exact extracted-copy commands, outcomes and remaining gates.

## Required items 1–6

### 1. Plausible orphan invoices — FIXED

Reproduced: `P1 blocks renamed customer`, `P1 blocks discounted total`, `P1 blocks extra line`, and their prevention cases fail on RC6 in `logs/recovery-regression-before-RC6-native-final.log`. The three consequence controls force a manual release and execute the real issueInvoiceForOrder against the fake store; each produces a second invoice. These controls were retained.

Fix: `tools/stuck-invoicing-logic.js` flags an unclaimed invoice if customer ids match when both exist, otherwise normalised names match/contain one another, or any productId overlaps. Reliable earlier invoice dates exclude candidates. Unknown dates cannot exclude plausible matches. Items and total may differ. Existing pointers, deterministic ids, registry directions, conflicting claims and incomplete-input checks remain. An additional plausible orphan blocks completion advice even if one other invoice is linked. Nothing is auto-linked or written.

Tests: `tests/unit/recoveryRc61.test.js` and native recovery runner; fixed cases and clean/earlier/claimed/unrelated positive controls pass in `logs/recovery-regression-after-RC61-native-final.log`. Limits: broad matching intentionally generates review work for repeat-customer/product sales. It cannot identify a sale whose customer identity/name and all product identities have changed. Human source verification remains required.

### 2. Freeze timestamps — FIXED

Reproduced: ambiguous freeze times, malformed calendar dates, post-export timestamps and post-freeze document changes fail on original RC6 in the same before log. Representative failing name: `P2 rejects timestamp after freeze tolerance`.

Fix: explicit ISO times with seconds and Z or a numeric offset are required. Export must follow freeze. Available createdAt/updatedAt/approvedAt fields on every supplied export array are checked; malformed values, any timestamp after export or after freeze plus `FREEZE_TIMESTAMP_TOLERANCE_MS=1000` invalidate confirmation. Manifest mode checks export start as well as end. Output explicitly says the tool cannot verify the freeze itself; only statements and available times can be consistent. Unconfirmed freezes return exit 3, including nonempty stuck sets.

Files: recovery logic/CLI, `tools/export-manifest.mjs`; recovery and export regression tests. Tests cover explicit-offset controls, Firestore JSON timestamp forms, all three fields and other collections. Before/fix logs cover CLI exit-code integration separately in `logs/export-cli-review-before-RC61-native.log` and `logs/export-cli-review-after-RC61-native.log`. Limit: consistency cannot prove that maintenance rules were installed or remained active.

### 3. Existing-invoice completion — FIXED

Reproduced: `P3 ALREADY_INVOICED output contains completion checks, never release advice, read-only` fails on RC6 before log. Fixed output and the operations plan explain how to verify the existing sale/invoice/registry and next counter, complete only the order as Invoiced, clear attempt fields, retain an audit note, take fresh exports and re-run. There is no Approved/restart recommendation for ALREADY_INVOICED.

Files: recovery logic/CLI, `docs/RC6.1-OPERATIONS-PLAN.md`, recovery tests. Native after log passes the output and no-write assertions. Manual maintenance edits require independent developer/owner review and evidence; the tool does not execute them. Since an intentional repair changes updatedAt, record a fresh checkpoint while maintenance remains active before re-exporting.

### 4. Read-only export and manifest verification — FIXED

Reproduced: `paginates local REST using GET only, decodes timestamps, and records complete counts and file hashes` and the three `rejects a truncated file against its manifest with exit 3` cases fail on original RC6. See `logs/export-regression-before-RC6-native-inprocess.log`. The previous complete-file workflow is a positive control.

Fix: new `tools/export-readonly.mjs` and `tools/export-manifest.mjs`; all three assessment CLIs accept --manifest. The exporter only uses GET, fully follows pagination, rejects repeated tokens/documents, malformed pages, unsafe numeric values and failed requests, and writes the complete manifest last. The ten required targets are exported as id-bearing arrays, including the two singleton documents. Manifest metadata includes project, start/end times, counts and SHA-256. Remote reads require HTTPS at the Firestore API hostname, --allow-remote, a matching --confirm-project, and an environment-only FIRESTORE_ACCESS_TOKEN. Redirects are refused; no token is printed or stored. No real project was accessed.

Consumers verify all ten files, hashes, counts, ids, singleton shapes and metadata before using in-memory verified data. Missing/mismatched files return INCOMPLETE, exit 3. Explicit file overrides cannot silently select another bundle. No-manifest compatibility remains with a prominent UNVERIFIED notice and is not rollout clearance. Reconcile now prints its actual completeness, dataReadiness, maxLinesFound and releaseReadiness fields. A malformed null singleton returns INCOMPLETE rather than throwing.

Tests: `tests/unit/exportReadonlyRc61.test.js`, native fake-server before/after and CLI review logs. Limit: pagination is not an atomic cross-collection snapshot. A manifest detects local changes/truncation, not a server silently omitting documents or a deliberately rewritten manifest. Verify project and freeze independently.

### 5. Manager catalogue-price review — FIXED

Reproduced: `lower price requires explicit acknowledgement before any write`, its higher-price counterpart, acknowledgement audit and stale-acknowledgement cases fail on RC6. `logs/price-regression-before-RC6.log`: 9 failed, 1 equal-price positive control passed. `logs/price-regression-after-RC61.log`: 10 passed.

Fix: `src/orderPriceReview.js`, `src/stock.js`, `src/main.js`. Actual catalogue field is numeric `products.price`, as written by src/products.js. Manager list/modal show each difference and missing-price comparison note. Single, bulk and negative-stock-override approval paths request explicit acknowledgement. The transaction recomputes the review from current order/product reads, rejects stale acknowledgement, preserves agreed order prices and records actor, server time and affected order/catalogue prices in the existing append-only stockMovements records, atomically with approval and stock changes. Missing/invalid catalogue prices are visibly skipped. Stock still moves once.

Tests: new priceApprovalRc61 unit tests and E55 in the existing mocked browser suite; native tests include concurrent approval and transaction retry. Existing HTML-safety assertions are retained; plain-text confirmation strings must not bypass the HTML rendering safeguards. Browser E55 requires execution as part of the complete browser gate, not an inferred pass from the native tests.

OWNER DECISION: warn and acknowledge versus a future block. Current implementation warns and permits acknowledgement; it does not impose catalogue prices. Unchanged rules do not independently require this acknowledgement from a deliberately modified manager client. Review the stock-ledger audit under real rules before approval. A price that disappears after the manager view was loaded can leave its displayed missing-price note stale until refresh; the transaction skips a currently missing price.

### 6. Assessment CLI defects — FIXED

Reproduced in original RC6: `reports orderCancellations.json by its real name when missing`, `prints migration scope exclusions even when its assessment is CLEAN`, and missing-value cases such as `rejects --products without its value as usage error 2`. See export before/after logs.

Fix: `tools/migrate-rc3.mjs`, `tools/migrate-logic.js`, `tools/reconcile.mjs` and shared argument parsing. Missing filenames are accurate. Migration explicitly excludes stock-ledger/per-product restoration, customer/merge-lock and schedule-consistency checks and directs the operator to reconcile. Dangling, unknown and duplicate options are usage errors. No existing test assertion was removed or allowlist expanded.

## Existing-test changes disclosed

1. stuckInvoicing.test.js scenario 2b: same-customer/different-total expected SAFE_TO_RELEASE becomes NEEDS_REVIEW, the required corrected behaviour.
2. Its unrelated-customer positive control uses a distinct product id instead of reusing p1; a shared product is now intentionally a candidate. All six scenario groups remain.
3. Its nonempty missing-freeze CLI expectation changes from exit 1 to documented exit 3. The command still returns NEEDS_REVIEW and never SAFE_TO_RELEASE. Other exit-code assertions remain.
4. maintenance.test.js selects the authoritative RC6.1 report/guide/operations paths and asserts RC6.1 / 6.1.0-rc1 instead of RC6 / 6.0.0-rc6. Rule-hash, configuration, no-write and build-visibility assertions remain.
5. E55 is added to decisions.e2e.mjs; previous browser scenarios and assertions remain. New regression test files are additions. No test was skipped, deleted or softened to obtain a pass.

## Verification and environment limits

Executed focused native regressions pass with positive controls. The supplied original RC6 suite results are not represented as RC6.1 passes. Standard npm ci attempts encountered `spawn EPERM` in dependency lifecycle scripts. Supplementary locked installs using --ignore-scripts succeeded, but are not full clean-install passes. Vite's optional Windows `net use` discovery also throws EPERM before standard unit/build execution. An evidence-only preloader turns that single synchronous optional-probe failure into its normal error callback; it changes no app, dependency, assertion or actual subprocess execution. Supplementary production build succeeded and emitted RC6.1, with the existing large-bundle warning. Full-suite commands and separate supplemental outcomes are recorded in final evidence; any failed/blocked test remains failed/blocked, never a complete-suite pass.

Playwright setup was attempted at its default location (write denied) and in the workspace (browser downloader subprocess `spawn EPERM`). Java is not available on PATH. Real rules compilation, the complete real rules suite, RC6-MAX 12-line rules transactions, maintenance-freeze rules assertions and real Auth/Firestore browser workflows remain BLOCKED/UNEXECUTED. No emulator setup error is a passing negative test. The exact final command errors and exit codes are in the evidence. Rerun all gates on the developer's supported machine.

## Final status

- Item 1: fixed.
- Item 2: fixed.
- Item 3: fixed.
- Item 4: fixed.
- Item 5: fixed (warn-only owner decision; client safeguard).
- Item 6: fixed.
- Ready for developer review: YES — scoped changes, regression evidence, source/rules hashes, explicit limitations and acceptance steps provided. This is not a fully verified release.
- Required verification complete: NO — full lifecycle clean installs, complete unit/mock browser gates, standard production build confirmation, real rules/emulator gates and the operational gates remain for the developer as identified in evidence.
- Real Firebase verification: INCOMPLETE.
- Production deployment: NOT PERFORMED.

Before official go-live, the developer must execute the review guide commands successfully, perform real-emulator role/workflow checks, take and restore a backup, obtain complete real-data manifest-backed preflight results, confirm token revocation and collect owner decisions. Follow Outcome B if any required check or approval is missing tomorrow. Conservative recommendation: review RC6.1 promptly, but deploy only after those gates are proved; do not convert BLOCKED to PASS to meet the date.

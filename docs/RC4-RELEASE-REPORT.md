# RC4 release report (authoritative)

Date: 2026-10-18. Base: RC3 (`7014b8e`, branch `claude/fixes-oct-2026`). This report replaces every earlier status claim (VALIDATION-REPORT.md, REVIEW-RESPONSE.md and the RC3 evidence are superseded).

## VERDICT: NOT READY for production rollout

Reason: the two checks that exercise the security rules and real Firebase Auth/Firestore are **BLOCKED** in the build environment, and RC4 changes the rules substantially (transition table, attempt token, bounded line schema). Rules that have never been compiled or run must not be deployed. Everything that could be executed here passed.

## Check results

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Unit suite (20 files, 398 tests) | `cd tests && npx vitest run --config vitest.config.mjs --configLoader native` | **PASS** 398/398 (log `unit.log`) |
| 2 | New regression tests fail on RC3 source | same files copied onto `7014b8e` | **PASS** (proof): 38 failures in 7 files (`fail-on-original-RC3.log`) |
| 3 | Browser e2e, in-memory backend (52 checks incl. E53 injection) | `cd tests && npm run test:e2e` | **PASS** 52/52, exit 0 (`e2e.log`) |
| 4 | E53 fails on RC3 | decisions e2e on `7014b8e` | **PASS** (proof): E53 FAIL, exit 1 (`e2e-E53-on-original-RC3.log`) |
| 5 | Production build | `npm run build` | **PASS** exit 0, only the chunk-size warning (`build.log`) |
| 6 | Firestore rules suite (existing 170 cases + RC4 adversarial groups RC4-H, RC4-I) | `cd tests && npm run test:rules` | **BLOCKED** (`rules.log`) |
| 7 | Browser workflows on real Auth + Firestore emulators | `run-app-on-emulators.bat` + `seed-emulator.mjs` | **BLOCKED** (same cause); item 3 uses an in-memory fake, which is NOT a substitute |
| 8 | Real rules compiler on `rules/firestore.rules` | emulator start | **BLOCKED**; only the static lint in `deployConfig.test.js` ran |

Blocked reason (exact): `Error: download failed, status 403: request blocked: no rule or allowlist entry allows host "storage.googleapis.com"` while downloading `cloud-firestore-emulator-v1.19.8.jar`. Also, `@firebase/rules-unit-testing` 6.0.0 needs Node >= 24.12 (this environment: Node 22.22.0).

Command needed to finish (on a Windows PC with Node >= 24.12, Java 21 and internet access): `run-rules-tests.bat` (or `cd tests && npm install && npm run test:rules`). Expect the existing cases plus RC4-H / RC4-I to pass. If any fail, fix the rules before anything else.

A note on the e2e history: one earlier e2e run showed failures in E19-E22 because a second, stray e2e process was writing to the same log and ports at the same time (interleaved lines). The clean rerun (check 3) has 52/52. The original RC3 code had the same suite at 51/51 plus E53 new.

## Disclosed changes to existing tests (no assertion removed or weakened)
- `tests/unit/decisions.test.js`: 3 tests encoded the retroactive-merge defect (finding 4) and now assert date-aware behaviour.
- `tests/unit/reconcile.test.js`: older "safe" cases now supply every required input (assertions unchanged) because missing inputs now mean INCOMPLETE.
- `tests/rules/invoicing.rules.test.js`: fixtures updated to the RC4 rules (valid order lines, `invoicingAttemptEnded`, an Approved order can no longer be Rejected so that assertion became `assertFails` and a separate Submitted order is rejected instead). These fixture edits have not been executed (check 6).

## Findings summary
See `docs/RC4-REVIEW-FIXES.md` (defect, fix, files, tests per finding, migration, rollback).

| Finding | Fixed in code | Verified here |
|---|---|---|
| 1 HTML injection | yes | unit + e2e E53, fail-on-original proven |
| 2 Lifecycle and locks | yes (rules + client token) | client unit tests; **rules BLOCKED** |
| 3 Line / money validation | yes (rules bounded schema + client revalidation) | client unit tests; **rules BLOCKED** |
| 4 Merge-aware history | yes | unit; legacy merges flagged ambiguous |
| 5 Reconciliation | yes | unit incl. the p1=2/p2=3 vs 5/0 case |
| 6 Deployment config | yes | static lint only; real compiler **BLOCKED** |
| 7 Conflicting imports | yes | unit + e2e E47-E50 |

## Hashes (SHA-256)
- `rules/firestore.rules`: `efc437f531c0f319f65b9307732c788d193436dee4f2618993b214e27c9395da`
- App ZIP and evidence ZIP hashes: listed in `HASHES.txt` inside the evidence ZIP and in the delivery message (a file cannot contain its own archive's hash).

## Deployment order (once check 6 passes on the nephew's PC)
1. Take a Firestore export/backup (console) first.
2. Run `node tools/reconcile.mjs` read-only against the emulator copy or a dry-run export; fix INCOMPLETE / FINDINGS.
3. Deploy the new web build, tell ALL staff to close and reopen the app (hard refresh) BEFORE step 4: old clients do not write `invoicingAttemptEnded` and would be refused.
4. Deploy `rules/firestore.rules` (`firebase deploy --only firestore:rules,firestore:indexes` run by the nephew, never by this tool).
5. Pilot: one manager and two reps for one working day: place an order, approve, invoice, deliver, cancel a Submitted order, merge two test customers, import a plan. Watch for permission-denied messages.
6. Rollback: see RC4-REVIEW-FIXES.md (RC3 rules + RC3 build together; no data rewritten).

## Remaining limitations and risks
1. Rules never compiled or run (BLOCKED). The expression budget (1,000 per request) for 12-line orders and invoices, the document-access limits (10 per request, 20 per batch/transaction) and syntax are unverified. 12 lines was chosen conservatively; if the emulator shows budget errors, reduce the cap.
2. New business limit: at most 12 lines per order / invoice. Needs the owner's approval; the UI states it.
3. An order's invoice may still differ from its order lines (not changed; business decision).
4. Legacy merges (before RC4) cannot be reconstructed: affected old visits are reported ambiguous and credited to no shop.
5. Legacy `Invoicing` locks with no attempt token require manual review; orders with invalid stored lines cannot be approved or edited until corrected.
6. Old manager clients must refresh before the rules are deployed.
7. Mock-backed browser tests do not prove authorization. The leaked GitHub token must still be revoked by the nephew. No production Firebase was contacted; nothing was deployed or pushed in this session.

# REAL FIREBASE VERIFICATION INCOMPLETE - NOT APPROVED FOR PRODUCTION

# RC6.1 developer review guide

RC6.1 / package version 6.1.0-rc1. This guide and RC6.1-RELEASE-REPORT.md supersede RC6 where they differ. No deployment, production read, login or push was performed. A candidate for review is not go-live approval.

## Review highest-risk changes first

- `tools/stuck-invoicing-logic.js`: broad unclaimed-invoice matching, explicit-zone freeze times, cross-export timestamp checks and manual ALREADY_INVOICED completion. SAFE_TO_RELEASE is advice only; false-positive review cases are expected. Verify the next-counter convention against `src/numbering.js` / `src/orders.js`.
- `tools/export-readonly.mjs`, `tools/export-manifest.mjs`, all three assessment CLIs: GET-only pagination, remote double opt-in, no token logging, file counts/hashes, timestamp consistency and fail-closed input handling. Manifest integrity does not establish snapshot completeness or a real write freeze.
- `src/orderPriceReview.js`, `src/stock.js`, `src/main.js`: manager price differences, visible missing-price notes, explicit acknowledgement, transaction recheck and append-only stock-ledger audit. Confirm all single/bulk/shortage-override approval paths. Submitted prices are preserved.
- `tests/unit/*Rc61.test.js`, `tests/e2e/decisions.e2e.mjs` E55; evidence native runners and before/after logs. Unchanged rules hash is in HASHES.txt. Inspect the explicit existing-test changes in the release report; no assertion was removed to obtain a pass.

## Commands and acceptance criteria

Use Node satisfying package engines (>=24.12.0), npm, Java and working emulator downloads. Run from a fresh extraction of the exact reviewed source. Capture raw output and exit codes; do not reuse RC6 logs as RC6.1 verification.

| Check | Command | Required result |
|---|---|---|
| Root clean install | `npm ci` | Exit 0, lifecycle scripts complete; an `--ignore-scripts` install is not a substitute. |
| Test clean install | `cd tests` then `npm ci` | Exit 0, scripts complete. |
| Complete mocked unit suite | In tests: `npx vitest run --config vitest.config.mjs --configLoader native` | Exit 0, zero failed/skipped/unhandled errors. Includes all old and RC6.1 regressions. |
| Complete mocked browser suite | In tests: `npx playwright install chromium`, then `npm run test:e2e` | One process only; exit 0, all scenarios pass including E55; zero unexpected browser errors. A real browser with a fake backend remains MOCKED. |
| Production build | In root: `npm run build` | Exit 0; `dist/build-id.txt` exactly RC6.1; visible Build RC6.1 on the built page. Review bundle-size warnings separately. |
| Real rules compilation and complete rules suite | In tests: `npm run test:rules` | Exit 0, no compilation error, zero failed/skipped tests. Actual emulator running the reviewed rules, not the in-memory helper. |
| Maximum transaction size | Included in the same rules run: group `RC6-MAX. 12-line orders: approval, edit, invoice and cancellation transactions` in `tests/rules/invoicing.rules.test.js` | All cases genuinely execute with real SDK and rules, including 12 product updates/movements, edit, invoice and cancellation. Permission errors and transaction-access limits must not be ignored. |
| Maintenance freeze | Included in the same rules suite using `rules/maintenance-freeze.rules` | Positive manager-read control passes and every required client write is denied. Successful setup plus actual assertions required; failed setup is BLOCKED. |

`npm run test:rules` uses the isolated `naisi-rules-test` project and firebase.emulators.json. No production project or token is needed. If Java, downloads, subprocesses or emulators are unavailable, record the exact error and keep the affected checks BLOCKED.

## Real Auth/Firestore browser workflow (still required)

Use the existing emulator configuration/start scripts and docs/WINDOWS-TESTING.md. Point the actual built client at local Auth and Firestore, seed fake manager/rep/deliverer users and catalogue data, and load the reviewed application rules. Confirm DevTools traffic uses the emulator; no fakeFirestore alias or in-memory backend is acceptable for this gate. Record screenshots, ids, exact amounts and transaction results.

1. Rep signs in; today's route and no-order visit work; catalogue order submission cannot create an untracked line.
2. Manager sees equal/lower/higher/missing-catalogue-price cases. Cancelling acknowledgement writes nothing; accepting keeps agreed prices and writes actor, server time and both prices to stockMovements atomically. Change a catalogue price between view and approval; stale acknowledgement must trigger a new review.
3. Approve once and repeat/double-click: stock is deducted exactly once. Issue once and repeat: one invoice and one number-registry entry. Test 12-line orders. Verify the counter is the next suffix, not an issued suffix.
4. Complete dispatch/delivery/payment and valid/invalid expense flows. A rep cannot perform manager writes. Under maintenance freeze valid client writes are denied, not silently accepted.
5. Rehearse GET-only export, manifest validation, reconcile, stuck-order review and ALREADY_INVOICED completion with fake data. Tamper with a copied export: every assessment must reject it as INCOMPLETE, exit 3. Keep the originals.

## Owner and operational decisions

Owner approves warn-only price differences with explicit acknowledgement versus a future server-enforced block; unchanged rules do not independently require the acknowledgement from a deliberately modified manager client. Also confirm the 12-line cap, expense amount policy, historical invoice custom-line compatibility and manual recovery policy. Confirm previously reported token revocation without exposing a token. Take and restore a backup into a scratch environment and compare collection counts and representative balances/links. Verify the exact live build and select Outcome A or B in RC6.1-OPERATIONS-PLAN.md.

No official go-live approval until every required verification above passes, real-data preflight is COMPLETE/READY, backup/restore is proven, owner decisions are accepted and the developer signs off. If any remain blocked tomorrow, use the documented approved live/manual fallback.

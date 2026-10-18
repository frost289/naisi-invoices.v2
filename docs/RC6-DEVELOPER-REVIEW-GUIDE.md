# RC6 developer review guide (short)

**REAL FIREBASE VERIFICATION INCOMPLETE — NOT APPROVED FOR PRODUCTION.** Rules, rules compilation and emulator browser flows have not been run.

## 1. What changed from RC5 (review these, nothing else moved)
| File | Change | Risk |
|---|---|---|
| `tools/stuck-invoicing-logic.js`, `tools/stuck-invoicing.mjs` | rewritten: link/registry/orphan analysis, freeze confirmation, incomplete-input handling, exit codes 0/1/2/3 | highest: it advises a manual database edit |
| `tools/reconcile-logic.js`, `tools/reconcile.mjs` | `products` is a required input | medium |
| `tools/migrate-logic.js`, `tools/migrate-rc3.mjs` | `products`, missing-input INCOMPLETE, UNKNOWN_PRODUCT | medium |
| `src/orderLines.js` (`lineKind`) | `custom` present but not `true` on an unproductive line is invalid in all modes (matches rules `!('custom' in l)`) | low-medium: client only |
| `public/build-id.txt`, `package.json`, lockfile | RC6 / 6.0.0-rc6 | low |
| `tests/rules/invoicing.rules.test.js` (+ groups `RC6-P3`, `RC6-MAX`), `tests/rules/freeze.rules.test.js` | new emulator tests, not run | — |
| `rules/firestore.rules` | **unchanged from RC5** (SHA-256 in HASHES.txt) | — |

## 2. Decisions needed from the owner
12-line cap (run the preflight, read `maxLinesFound`); expense amount policy; recovery cancel + manual stock adjustment; custom-line behaviour (table in the report, P3; decide whether the historical no-flag invoice line stays allowed for new invoice writes or only for old records); confirm the exposed GitHub token is revoked (developer).

## 3. Compatibility
Stale clients: see report P3. No data is rewritten. Tools are read-only; the only database edit anywhere is the manual release of a stuck Invoicing order, and only when the classifier says `SAFE_TO_RELEASE` after a frozen, fresh export.

## 4. Run the blocked checks (Node >= 24.12, Java 21, firebase-tools; emulator jar must be downloadable)
```
npm ci && (cd tests && npm ci)
cd tests
npm run test:rules          # includes: existing groups, RC5-A, RC5-B, RC5-B2, RC6-P3, RC6-MAX and freeze.rules.test.js
npm run test:e2e            # single process only (mock-backed)
```
Acceptance: `test:rules` exits 0 with **0 failed, 0 skipped**; the log shows the rules compiled with no warnings; `RC6-MAX` shows approve/edit/invoice/cancel at 12 lines succeeded with no "maximum"/"exceeded" error (if any appears: lower `MAX_ORDER_LINES` in `src/money.js`, the unrolled rules and tests, and tell the owner); the freeze file test shows every write denied and manager reads allowed; `sha256sum rules/firestore.rules` equals HASHES.txt. A test that fails because the emulator did not start is a SETUP FAILURE, not a pass.
Then the real-emulator browser walk (run-app-on-emulators.bat, `node tools/seed-emulator.mjs`): rep sign-in, schedule, visit outcomes, order submission; manager approval (stock deducted once); one invoice per order; delivery; expense validation (a seeded malicious amount shows "Invalid amount"); repeated clicks; the stuck-Invoicing and preflight tools on the seeded data.

## 5. Mocked vs real
Unit and existing browser suites use in-memory backends (application logic only). Nothing in this package has been executed against the real Firestore rules.

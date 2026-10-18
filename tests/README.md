# Tests

## Supported versions
Node.js **24.12+** (24 LTS), npm 10+, Java **21** (emulator only), firebase-tools 14.27.0 (installed by `npm ci` in this folder). Details and Windows steps: `../docs/WINDOWS-TESTING.md`.

## Commands (after `npm ci` in `tests`)

| Command | What it proves | What it does NOT prove |
|---|---|---|
| `npm test` | 15 files / 284 tests (RC2 had 12 / 182: added decisions 71, migrate 5, scheduleSuggest 16, reconcile +7, others updated): the app's real `../src` code against an in-memory Firestore stand-in (transactions, retries, failure injection) | the real SDK, network, security rules, a browser |
| `npm run test:rules` | 170 test cases (RC2: 99). NOT yet run on an emulator by the developer: the FINAL rules file (`../rules/firestore.rules.FINAL-CANDIDATE`) on the local Firestore emulator for manager, reps, deliverer, stranger and anonymous, including the real app functions (visits, orders, customers, invoicing, merge, products) and one order through rep -> manager -> deliverer | the screens |
| `npm run e2e:browser-setup` then `npm run test:e2e` | 48 real-browser checks E1-E48 against an in-memory backend | the real emulators or rules |
| `npm run test:all` | the three above | the manual walkthrough in `../docs/WINDOWS-TESTING.md` part B |

The rules tests route `firebase/firestore` and `@firebase/rules-unit-testing` to one CommonJS copy of the SDK (`helpers/*-cjs.mjs`, regenerate with `node helpers/make-cjs-wrappers.mjs`); without that the app code and the test fixtures use two SDK builds and `doc()` rejects the Firestore object before any rule runs. This changes no security expectation. The test configs also disable esbuild and use one worker thread so that no helper processes are spawned. `NAISI_RULES_PATH` overrides the rules file under test.

Browser tests build the real app with `firebase/*` replaced by in-memory fakes (`e2e/firestoreBrowser.js`, `e2e/authFake.js`); data persists to localStorage so a refresh can be tested, with failure injection for failed saves and lost acknowledgements. Setting `VITE_USE_EMULATORS=true` at build time makes `src/firebase.js` use the emulators on 8080/9099 (see `run-app-on-emulators.bat`).

## Files

| File | Covers |
|---|---|
| `unit/stock.test.js` | repeated product lines, aggregate shortage, cancel, stale cached order, edit (retry, concurrent, stale revision, status change, atomicity) |
| `unit/items.test.js` | edit rows keep `productId` |
| `unit/conversion.test.js` | cases to packs validation, receipt atomicity, ledger consistency, unitsPerCase validation |
| `unit/invoicing.test.js` | one invoice per order, failure at the invoice commit, lost acknowledgement, contention retry, lock token/lease/revert, legacy lock, `ord_` conflict, stale bulk data, standalone idempotency |
| `unit/invoiceFlow.test.js` | PDF failure after save does not issue another invoice |
| `unit/bulkProgress.test.js` | overlapping jobs, re-entry, de-duplication, button locking, retry-failed-only, PDF retry |
| `unit/pagination.test.js` | out-of-order responses, stale failure, loading state, double Load more |
| `unit/reconcile.test.js` | read-only reconciliation classification, incl. RC3 checks |
| `unit/decisions.test.js` | the eight owner decisions |
| `unit/migrate.test.js` | migration planner |
| `unit/scheduleSuggest.test.js` | distance-based schedule suggestions (docs/SCHEDULE-BY-DISTANCE.md) |
| `unit/malawiTime.test.js` | Malawi date, weekday and range helpers across the UTC boundary |
| `unit/visits.test.js` | visit validation, atomic order+visit, idempotent retry, conflict, failure atomicity |
| `unit/visitSchedule.test.js` | scheduled lists, distinct progress, performance report, schedule-change warning |
| `unit/reportLoader.test.js` | manager report: newest range wins, out-of-order and failing stale responses, range limit |
| `e2e/visits.e2e.mjs` | E1-E25 here; E26-E48 in `e2e/decisions.e2e.mjs` |

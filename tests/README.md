# Tests

## Run (mock tests - no Firebase, no network)

    cd tests
    npm install
    npm test

Runs `vitest` with `vitest.config.mjs`. All paths are relative to this folder; nothing depends on a particular machine. Node 20+.

## What these tests ARE

They run the app's real source files (`../src/*.js`) against an **in-memory stand-in for Firestore** (`helpers/fakeFirestore.js`) that models transactions (reads before writes, all-or-nothing commit, re-run on conflict, max 5 attempts), plus failure injection at the commit (`hooks.failCommit`, `hooks.failAfterCommit`) and a controllable clock. The bulk window runs in jsdom.

## What they are NOT

They do not exercise the real Firebase SDK, the network, offline persistence, retry timing, **security rules**, a real browser, jsPDF, or file downloads. A passing run does not prove the rules accept the new writes or that the screens work. The handlers in `src/main.js` (button wiring) are not unit-tested; they are covered by the manual list in `docs/DEVELOPER-NOTES.md`.

## Emulator tests (rules) - written, NOT RUN

    cd tests
    NAISI_RULES_PATH=/absolute/path/to/firestore.rules npm run test:rules

Needs Java and the Firestore emulator (`firebase-tools` downloads it). Adapt `seedUsers()` in `rules/invoicing.rules.test.js` to your manager check first. Without `NAISI_RULES_PATH` the file is skipped. These tests encode the behaviour proposed in `../rules/invoicing.rules.fragment`; failures against your current rules show the gaps.

## Browser tests (daily visits) - run against an in-memory stand-in, NOT the emulators

    cd tests
    npm run test:e2e        # about 100 s; builds the app with Firebase aliased to local fakes, then drives headless Chromium (phone viewport, America/Los_Angeles time zone)

`e2e/` builds the real app with `firebase/*` replaced by `e2e/firestoreBrowser.js` and `e2e/authFake.js` (in-memory, data persisted to localStorage so refresh can be tested; failure injection for failed saves and lost acknowledgements). Non-local network requests are aborted. 22 checks (E1-E22) cover the visit workflow. This is NOT the Firestore or Auth emulator (the emulator download is blocked in the build environment) and it knows nothing about security rules. Setting `VITE_USE_EMULATORS=true` at build time makes `src/firebase.js` use emulators on 8080/9099 for anyone who can run them. Checks that need the emulators or the real rules are BLOCKED.

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
| `unit/reconcile.test.js` | read-only reconciliation classification |
| `unit/malawiTime.test.js` | Malawi date, weekday and range helpers across the UTC boundary |
| `unit/visits.test.js` | visit validation, atomic order+visit, idempotent retry, conflict, failure atomicity |
| `unit/visitSchedule.test.js` | scheduled lists, distinct progress, performance report, schedule-change warning |
| `e2e/visits.e2e.mjs` | 22 real-browser checks E1-E22 (see above) |

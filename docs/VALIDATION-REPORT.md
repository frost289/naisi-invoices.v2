# Validation report (honest)

## Actually run, in the environment that produced this patch (15 Oct 2026)

| Check | Result |
|---|---|
| `npm test` in `tests/` (vitest, mock Firestore, jsdom) | 8 files, 102 tests, all passing |
| `vite build` in the repo root | passes |
| `node --check` on every edited JS file | passes |
| Mutation check: deliberately removing (a) the stale-response check in the pagination guard, (b) lock-token comparisons in commit and revert, (c) the identical-content no-op in edit | 6 tests failed as expected; originals restored; suite green again |
| Confirmation of all findings against the first patch | 18 of 19 confirmation tests failed there; the one that passed did not indicate a defect |

These are **mock tests**. They show the logic is consistent against an in-memory model of Firestore transactions. They do not show the app works on real Firebase.

## NOT run - still required

| Item | Why not run | Who/what is needed |
|---|---|---|
| Firestore emulator tests with the real rules (`tests/rules`) | Real rules not in the repo; emulator download blocked (HTTP 403) | Someone with `firestore.rules`; `NAISI_RULES_PATH=... npm run test:rules` |
| Rules compatibility (product allowlist, `Invoicing -> Invoicing`, `getAfter`, new fields) | Same | Same; adapt `rules/invoicing.rules.fragment` |
| Real Firebase behaviour (SDK retry timing, offline persistence, lost acknowledgements) | No access, by instruction | Non-live project test |
| Browser/UI: the handlers in `main.js` (single-invoice screens, edit modal, stock modal, notices, lists) | No browser session against the app | Manual test list in `docs/DEVELOPER-NOTES.md` |
| PDF generation/download failure and the Download PDF retry in a real browser | jsPDF/download not exercised | Manual test 6 |
| Old-client behaviour before/after the rules | Needs two builds and the rules | Staged test per `docs/DEPLOYMENT-AND-RULES.md` |
| Reconciliation against real data | No data access, by instruction | Run `tools/reconcile.mjs` on a read-only export; review by a person |
| `INVOICING_RESUME_ENABLED = true` | Deliberately off | Only after reconciliation and rules |

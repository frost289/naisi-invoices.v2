# RC6.5: fixes for the 18 failing rules tests (emulator run of 30 Oct 2026)

Branch: `claude/rules-test-fixes-rc6.5`, based on `claude/fixes-oct-2026` at `b842683`.
Rules SHA-256: see `rules/RC6.5-RULES-SHA256.txt`.

**Not yet verified on the Firestore emulator.** The emulator could not be downloaded where these changes were made.
Unit tests (657) and the browser e2e checks (`npm run test:e2e`) pass. The rules suite must be run before any deploy:

```
git fetch origin
git checkout claude/rules-test-fixes-rc6.5
cd tests && npm ci && npm run test:rules
```

Send back the full output. Do not deploy rules or hosting until it shows 0 failed.

## What failed and what changed

| Failing tests | Cause | Fix |
|---|---|---|
| RC6-MAX (4), K "12 product lines", RC5-B "exactly 12 lines" and "maximum size" | 12-line orders exceed the rules budget of 1,000 evaluated expressions per request (the log says so) | `MAX_ORDER_LINES` 12 → **6** (`src/money.js`); the rules' unrolled line checks cut to 6; tests now follow the constant. The price card has 4 products, so 6 lines covers every product plus extra lines. This is the step the RC5/RC6 review guides prescribed for this exact failure. |
| H "addCustomer works" | `addCustomer` stamped the first pin with an EMPTY email when none was passed; the rules accept the stamp only with the caller's real email, so the whole create was refused | `src/customers.js`: no stamp unless both uid and email are present |
| L "double click", K "two managers' cancel", M "three invoices", M "adjustment + invoice" | Two commits racing: the slower one is checked against the data the faster one just wrote and is refused with permission-denied, which the SDK does not retry | New `src/contention.js` (`runTransactionWithRetry`), used by manager order entry, cancel, invoice commit and counter adjustment. It re-runs ONLY when a watched document changed during the attempt; a refusal on unchanged data is thrown at once. Unit tested in `tests/unit/contention.test.js`. |
| P "without a lock nothing is re-pointed" | The invoice rule let a manager move an issued invoice between any two unlocked customers (owner decision 8 says only in a merge) | Rule clause removed: an invoice's `customerId` changes only under the merge lock. `src/invoices.js` `updateInvoice` explains this to the manager instead of a permission error, and keeps the link when the name is merely retyped. |
| D "manager can re-point ... merge lock", P "locked customer's records" | The rules require `originalCustomerId` on a visit re-point (finding 4) and the app always writes it; these two raw tests did not | Tests send `originalCustomerId`, as the app does. One extra assertion: the original shop can never be rewritten. |
| P "interrupted merge" | The app now refuses a schedule change on a locked customer itself (`customer-merging`) before the rules are reached | Test uses `assertRejects` for that app call (the rules refusal is covered by the raw tests) |
| M "year part must be four digits" | Test bug: each `as('mgr')` creates a new Firestore instance, and one batch cannot mix instances | Test uses one instance |
| L "rep and stranger cannot call manager entry" | Test bug: expected a fixed 3 orders; the shared fixture has held 4 since RC4 | Test compares with the count before the attempts |

No test was weakened: every assertion that checks a rule still checks it.

## Before deploying

1. `npm run test:rules` shows 0 failed. If the RC6-MAX group still reports "maximum of 1000 expressions", lower `MAX_ORDER_LINES` to 5 and cut the unrolled rules to match.
2. Run the read-only preflight on a production export: any open order with more than 6 lines must be split or cancelled first (it can no longer be approved or edited).
3. Deploy order is unchanged: indexes (wait for READY), then hosting, then rules.

## Not in this release

The expense upgrades withdrawn in RC6.4 (payee, payment method, receipt reference, stock purchases) are still to be built. They are the owner's next priority and should be built as one complete feature: fields, screens, rules, reports and tests together.

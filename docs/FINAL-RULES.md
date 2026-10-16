# Final rules candidate: what it does, what it assumes, what is NOT verified

File: `rules/firestore.rules.FINAL-CANDIDATE` (one complete file, all collections, all roles). Built from the rules supplied 2026-10-16; every
rule not listed below is unchanged. **Not deployed. Not yet run on an emulator by its author** (the emulator cannot be downloaded in the
authoring environment). Run `run-rules-tests.bat` (see `docs/WINDOWS-TESTING.md`) before anyone treats it as safe.

## Changes by role
| Role | Change |
|---|---|
| Rep (submitter) | May read a visit/order that does not exist yet only at its own id (`v_<uid>_*`, `o_<uid>_*`): fixes the first-save denial. Visits and orders must be well-formed, for an active customer, saved in ONE commit with the counter step. Cannot create inactive customers, set/change `active`, `assignedDay`, `assignedDayChangedAt` (contact, name, location and pin edits still work). |
| Manager | Same as before, plus: invoices need the counter to move by one in the same commit; order-linked invoices need the order to move Invoicing -> Invoiced in the same commit; lock needs server time + expired lease for takeover; invoice identity fields cannot change; may re-point a visit to another customer (merge). Manager order creation is unrestricted (no screen uses it). |
| Deliverer | Unchanged. |
| Unauthorized | Unchanged (nothing readable or writable; only signed-in users can read `config/roles`). |

## Decisions that need the owner's agreement
1. Reps can no longer create orders outside the visit workflow. An old browser tab still running the previous app version will have its rep order refused (the screen shows the error); reload fixes it.
2. Old-version invoice writes (automatic id, no `orderId`) are refused for managers too: managers must reload the app after release.
3. A customer's `active=false` and visit days can only be changed by managers. A rep who adds a shop gets it active with the app's automatic Mon-Sat day.
4. `unitsPerCase` is checked only when it is written or changed, so products already holding an odd old value can still have stock updated. Upper bound 1,000,000.
5. Order counter: the order counter now stores `lastOrderId`; managers keep the original +1 behaviour. Invoice counter manual override (`setCounterStart`) is still allowed for managers; the invoice rule requires the NEXT invoice to use the counter value read before its commit.
6. `config/depot` has no rule in the supplied file (the "set depot" screen is therefore denied for everyone). Not changed here; decide separately.

## Known limits / risks (unverified until the emulator run)
* Document-access limit: the order and visit rules use several `get/exists/getAfter` calls. Firestore allows 20 per multi-document write and caches repeats of the same document; if the emulator counts differently the rep order save will fail and the rules need trimming.
* `string()` of an integer, `.trim()`, `duration.value(10,'m')` and `getAfter()` on a path touched in the same batch are used; they are standard but were not executed by the author.
* Invoice numbers use `PREFIX-YYYY-NNNN`; the year is not checked (client clock), only prefix and counter value.
* A manager can still set an order to Delivered/Cancelled etc. without constraint (as before).

# Final rules candidate: what it does, what it assumes, what is NOT verified

File: `rules/firestore.rules` (one complete file, all collections, all roles). Built from the rules supplied 2026-10-16; every
rule not listed below is unchanged. **Not deployed. Not yet run on an emulator by its author** (the emulator cannot be downloaded in the
authoring environment; the QA review ran an earlier copy of the tests there: 91 of 94 passed, the 3 failures were test mistakes, now corrected). Run `npm run test:rules` (see `docs/WINDOWS-TESTING.md`) before anyone treats it as safe.

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
6. RC3: the depot screen, navigation and its reads/writes were removed (owner decision 5). No `config/depot` rule exists or is needed; routes start from the phone GPS.

## Known limits / risks (unverified until the emulator run)
* Document-access limit: the order and visit rules use several `get/exists/getAfter` calls. Firestore allows 20 per multi-document write and caches repeats of the same document; if the emulator counts differently the rep order save will fail and the rules need trimming.
* `string()` of an integer, `.trim()`, `duration.value(10,'m')` and `getAfter()` on a path touched in the same batch are used; they are standard but were not executed by the author.
* Invoice numbers use `PREFIX-YYYY-NNNN`; the year is not checked (client clock), only prefix and counter value.
* A manager can still set an order to Delivered/Cancelled etc. without constraint (as before).

## Owner decisions still open (nothing here was decided by the developer)
| # | Question | Current behaviour | Why it matters |
|---|---|---|---|
| 1 | Customer creation, scheduling, activation | Reps may create customers (active, automatic Mon-Sat day) and edit contact/location/pin; only managers deactivate, reactivate or change days. | Confirm reps should not be able to deactivate a shop or move a visit day. |
| 2 | Legacy clients / mandatory visit record | A rep order without its visit and counter step in the same commit is refused; old browser tabs must reload. | Confirm reps have no other way to enter orders (no manager-entered orders on their behalf). |
| 3 | Manager order creation and counter overrides | Managers can create orders with any content and can step the order counter +1; the invoice counter can be set by hand (`setCounterStart`). | A manager could create an order with a duplicate number. Decide whether managers should be limited like reps. |
| 4 | Standalone invoices | Allowed (automatic id, `orderId: null`) but must move the invoice counter by one in the same commit. | Confirm they stay. |
| 5 | Depot settings | No rule exists for `config/depot`: the depot-pin screen cannot read or save for anyone (test J). | RESOLVED in RC3: screen retired. |
| 6 | Manager "cancel and delete" of an Approved order | Refused: the supplied rules forbid deleting orders (test J). The whole transaction fails, so stock and order stay unchanged. | Either allow manager delete of Approved orders in the rules, or change the app to cancel without deleting. |
| 7 | Historical performance targets after schedule changes | Reports measure past dates against the CURRENT schedule and say so on screen. | Decide whether history should be frozen per week. |
| 8 | A merge while an order is being invoiced | Merging customers fails (safe) if one of their orders is locked "Invoicing"; retry after it finishes. | Informational. |

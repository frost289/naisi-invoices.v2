# Suggest schedule by distance (manager tool)

Where: Customers -> Weekly Visit Schedule -> **Suggest schedule by distance**.

## What it does
* Groups shops that are close together onto the same weekday and keeps the days about equal in size (within 15%).
* **It only suggests.** Nothing is saved until the manager ticks shops and presses *Apply*. Each applied shop goes through the normal schedule change (`setCustomerVisitDay`): the customer and a dated `scheduleChanges` entry are written together, so the schedule history, "effective from the start of the Malawi day" and the security rules are exactly as before. **No rules change was needed.**
* Two modes: **Only place shops that have no day yet** (default, recommended: nobody already scheduled moves) and **Re-plan every shop** (shows who would move, e.g. "Monday -> Wednesday"; any shop can be unticked).
* Days used can be chosen (for example tick off Saturday).
* Shows, per day, the number of shops and an approximate route length now versus suggested (same route-ordering code as the reps' route screen).

## Safeguards
* Shops with no map pin are listed and left alone; they are never guessed. Closed shops and shops being merged are ignored.
* If another manager changes a shop's day after the suggestion was calculated, that shop is **skipped, not overwritten**, and the summary says so.
* One shop failing does not stop the others; the summary lists failures. Re-running a suggestion that was already applied writes nothing.
* Past reports are not affected: history entries are dated, and a change counts from the Malawi day it was saved.

## Limits (be aware)
* Distance is **straight-line**, not road distance. In Lilongwe the road distance can be noticeably longer and depends on the route, so treat the km figures as a comparison between plans, not as driving distances.
* It balances the **number of shops**, not their sales value or time per visit.
* The grouping is a good heuristic, not a proven optimum; the manager's judgement (for example a shop that only opens on market day) always comes first.
* All reps share one daily list (owner decision 1), so the plan is for one route per day, not per rep.

## Tests
Unit: `tests/unit/scheduleSuggest.test.js` (grouping, balance, determinism, no-pin/closed/merging exclusion, stale skip, partial failure, idempotent re-run). Browser: E43-E47. Not run on the real emulators yet (see docs/WINDOWS-TESTING.md part B: add a step to try it).

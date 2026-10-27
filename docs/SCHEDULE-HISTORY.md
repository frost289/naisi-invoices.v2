# Dated schedule history (decision 7)

* A manager starts the history once (Customers). It stores `config/scheduleHistory.startedAt` (server time) and one **baseline** entry per existing customer (today's real state).
* Every later change (assign day, move day, deactivate, reactivate) writes an append-only `scheduleChanges` entry with actor and server time. Entries can never be edited or deleted.
* **A change takes effect from the start of the Malawi day (UTC+2, no daylight saving) on which the server saved it.** A report for a past date uses the last entry on or before that date.
* **Dates before the history start are "no reliable history"**: reports show a limitation notice, no targets and no percentages. Nothing is back-filled or guessed.
* Unscheduled customers (no day) and deactivated customers are not targets on any date they were in that state.
* Merged shops count once, credited to the surviving customer (`customerMerges` record).
* Tests: `tests/unit/decisions.test.js` (group 7), `tests/unit/visitSchedule.test.js`, browser E21, E26-E42, rules group O (not yet run on an emulator).

# Release checklist (owner authorisation required for every live step)

Do not start until QA has run `run-rules-tests.bat` and the manual walkthrough and every row of the evidence table is PASS.

1. **Backups**: export Firestore (all collections) and keep the current `firestore.rules` text. Record where they are.
2. **Artifacts**: check SHA-256 of the app ZIP and the rules file against `HASHES.txt` in the evidence pack.
3. **Configuration**: confirm `config/roles` lists the real managers/reps/deliverers; confirm no emulator flag (`VITE_USE_EMULATORS`) is set in the production build.
4. **Freeze old clients**: everyone closes and reloads the app (old manager clients would be refused by the new rules).
5. **Data**: run migration dry run and reconcile on the exported live data; resolve every HIGH item; owner authorises the migration.
6. **Deploy** (owner only): rules first, then the app. The developer did not and will not deploy.
7. **Acceptance checks on live (with a test customer)**: manager sees Walk-in Invoice; one order approve -> invoice -> deliver; numbering shows the expected next number; a manager starts the schedule history; rep sees shared schedule.
8. **Rollback**: re-publish the saved previous rules and previous build; the new documents (`scheduleChanges`, `invoiceNumbers`, etc.) can stay, old clients ignore them. Restore from the backup only for data damage.
9. **Owner sign-off** on the open risks in RC3-OWNER-DECISIONS.md and DEPENDENCIES.md.
10. **Security**: the GitHub token that was pasted into earlier chats must be revoked now.

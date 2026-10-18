> **RC5 NOTICE (SUPERSEDED-BY-RC5):** where this document disagrees with `docs/RC5-RELEASE-REPORT.md`, the RC5 report wins. In particular: there is NO rollback to RC3 and NO automatic ten-minute invoicing recovery (INVOICING_RESUME_ENABLED=false); use the freeze and stuck-Invoicing procedures in `docs/RC5-DEVELOPER-ROLLOUT-GUIDE.md`. Reconcile/migration preflight now reports invalid and oversized orders (RC4 notes claiming this were wrong at the time).

# Testing the final candidate on Windows (fake data only, nothing touches live Firebase)

## Supported versions (tested by the QA review; older versions are NOT supported)
| Tool | Version |
|---|---|
| Node.js | **24.12 or newer** (24 LTS; QA used 24.19.0). `@firebase/rules-unit-testing` 6.0.0 requires >= 24.12. The old "Node 20+" statement was wrong. |
| npm | 10 or newer (QA used 12.2.0). npm 12 blocks dependency install scripts; nothing here needs them. |
| Java | **21** (Temurin, QA used 21.0.12). Needed only by the Firestore emulator. |
| Firebase CLI | 14.27.0 (installed by `npm ci` in `tests`, do not install another) |

Do NOT run `firebase login`, `firebase deploy` or `git push`. Nothing in these steps needs them.

## One-time setup
1. Install Node.js 24 and Java 21, then restart the PC. In a new Command Prompt, `node --version` must print v24.12 or higher and `java -version` must print 21.
2. Unzip the app folder, for example to `C:\naisi-app`.
3. Install the test browser once: open Command Prompt in `C:\naisi-app\tests` and run `npm ci` then `npm run e2e:browser-setup`.

## A. Automated tests (run from `C:\naisi-app\tests`, after `npm ci`)
| Command | What it runs | Expected |
|---|---|---|
| `npm test` | 297 unit tests (in-memory stand-in) | 16 files, 297 passed |
| `npm run test:rules` | the rules tests against `rules\firestore.rules` on the local Firestore emulator (first run downloads about 60 MB) | 170 tests, all must pass (never run by the developer: this is the key QA step) |
| `npm run test:e2e` | 51 browser checks (E1-E41, E43-E52; in-memory backend) | 51 PASS |
| `npm run test:all` | all three | |

The same is available by double-clicking `run-rules-tests.bat` (rules only; it saves `tests\rules-test-output.txt`).
Keep the complete console output of every command and send it back unedited. A failure is information: do not change a test or a rule to make it pass.

## B. The real app on the local emulators (manual walkthrough)
1. Double-click `start-emulators.bat` and leave it open (viewer: http://127.0.0.1:4000).
2. Double-click `run-app-on-emulators.bat` (creates the fake accounts and data, then starts the app at the address it prints, usually http://localhost:5173).
3. Log in with email and password `Passw0rd!`:
   `mgr@example.com` (manager), `rep1@example.com` and `rep2@example.com` (sales reps), `deliv@example.com` (deliverer), `stranger@example.com` (no role).
4. Follow ONE order through all roles:
   - rep1: Today's Visits, pick a shop, "Order placed", add items, submit. Then a second shop: "No order", try submitting with no reason (must refuse), with "Other" and no explanation (must refuse), then a proper reason.
   - rep2: the same shops are listed, with its own progress.
   - mgr: visit report (numbers match), approve rep1's order, generate the invoice, check the invoice list and numbers.
   - deliv: the order is on the delivery list, mark it delivered.
   - mgr: Walk-in Invoice tab (standalone invoice), Numbering (adjust with a reason), cancel an Approved order (reason; stock restored once), enter an order for a rep, Customers: start schedule history, schedule a new customer, merge two customers (blocked while an order is Invoicing).
   - mgr: Customers -> Weekly Visit Schedule -> Suggest schedule by distance: calculate, check nothing changes until Apply, apply a few shops, confirm each gets a history entry (docs/SCHEDULE-BY-DISTANCE.md).
   - mgr: Customers -> Weekly Visit Schedule -> Import planned days from a spreadsheet: upload a small Name/Day file, check nothing changes until Apply, resolve one ambiguous name, apply, and confirm a history entry per shop (docs/IMPORT-PLANNED-DAYS.md).
   - stranger: nothing opens.
   - mgr: add a customer, change a visit day, deactivate and reactivate, merge two customers.
5. Write PASS or FAIL beside each step, with a screenshot of any failure.

If port 8080 or 9099 is busy, close the other program. Ports are set in `firebase.emulators.json`.

## If a command fails to start (Windows "spawn EPERM", antivirus or locked-down PC)
The test configs already avoid helper processes (esbuild disabled, one worker thread, native config loading). If `npm run test:rules` still reports it cannot start Java or the CLI, run it from a normal (non-sandboxed) Command Prompt as your own user, and send us the exact message. Do not edit the configs.

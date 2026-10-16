# Testing the final rules on your Windows PC (fake data only)

Nothing here touches the live Firebase project. Everything runs on your own computer against the Firebase *emulator*.

## One-time setup
1. Install **Node.js 20 or newer** (nodejs.org) and **Java 11 or newer** (for example Temurin, adoptium.net). Restart the PC after installing.
2. Unzip the app folder somewhere simple, for example `C:\naisi-app`.

## A. Run the automatic rules tests (about 3 minutes, most important)
1. Double-click **`run-rules-tests.bat`**. The first run downloads the emulator (about 60 MB).
2. When it finishes it shows PASS or FAIL for every test and saves everything to **`tests\rules-test-output.txt`**.
3. Send that file back. Do **not** change the rules or tests to make a failure go away: a failure means the rules and the app disagree, and that is what we need to know.

## B. Try the real app by hand against the emulator
1. Double-click **`start-emulators.bat`** and leave the window open (viewer: http://127.0.0.1:4000).
2. Double-click **`run-app-on-emulators.bat`** (loads fake shops, products and orders, then starts the app).
3. Open the address it prints (usually http://localhost:5173). Click Sign in with Google. In the emulator popup choose **Add new account**, type one of these emails and press Sign in:
   `mgr@example.com` (manager), `rep1@example.com` / `rep2@example.com` (sales reps), `deliv@example.com` (deliverer), `stranger@example.com` (no role).
4. Quick check list: as rep1 open Today's Visits, record one "No order" visit and one order; as mgr open the visit report and approve and invoice the order; as deliv deliver it; as stranger confirm nothing opens.

If port 8080 is busy, close the other program (or tell us; the ports are in `firebase.emulators.json`).

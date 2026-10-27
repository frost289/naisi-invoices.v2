> **RC5 NOTICE (SUPERSEDED-BY-RC5):** where this document disagrees with `docs/RC5-RELEASE-REPORT.md`, the RC5 report wins. In particular: there is NO rollback to RC3 and NO automatic ten-minute invoicing recovery (INVOICING_RESUME_ENABLED=false); use the freeze and stuck-Invoicing procedures in `docs/RC5-DEVELOPER-ROLLOUT-GUIDE.md`. Reconcile/migration preflight now reports invalid and oversized orders (RC4 notes claiming this were wrong at the time).

# Deployment, legacy-data reconciliation and rules

> RC3 update: read RC3-OWNER-DECISIONS.md, MIGRATION.md and RELEASE-CHECKLIST.md first. The rules to deploy are `rules/firestore.rules` (RC3). Old manager clients must be refreshed before the rules deploy. Merge chunks and baseline chunks are 8 because rules may use at most 20 lookups per batch.

Status: **procedure and proposals only.** Nothing here has been run against the real Firebase project. The deployed `firestore.rules` is not in the repository (it is git-ignored), so every rules statement below is unverified until someone with that file runs `tests/rules/invoicing.rules.test.js` against it.

## What the code guarantees, and what it does not

New-version code writes the order lock, the invoice number, the invoice and the order's "Invoiced" status in **one Firestore transaction**, with the invoice stored under the fixed id `ord_<orderId>`. Between new-version tabs this prevents two invoices for one order.

It does **not** protect against:

1. Browser tabs still running the previous version (they save the invoice with `addDoc`, then update the order separately).
2. Invoices an older version left orphaned (saved, but the order was never marked Invoiced).
3. Anything done directly in the Firebase console or by another client.

Only Firestore security rules can stop (1) and (3). Nothing in client code can. Until the rules in step 4 are deployed, the guarantee is "no duplicates between up-to-date tabs", not an absolute one.

## Order of work (do not skip or reorder)

1. **Freeze old clients.** Ask staff to close the app everywhere, then reload. (A hard cut-over time is needed because open tabs keep running old JavaScript until reloaded.) Deploy the new build to hosting **only after** step 3 passes on a test project.
2. **Export and reconcile (read-only).** Export `orders` and `invoices` as JSON arrays (each element with an `id` field), then run:

   `node tools/reconcile.mjs orders.json invoices.json`

   The script reads the two files and prints findings; it never contacts Firestore and changes nothing. Review every HIGH/MEDIUM finding by hand:

   | Finding | Meaning | What a person decides |
   |---|---|---|
   | `POSSIBLE_ORPHAN` | Order is Approved/Invoicing with no invoice link, and an unlinked invoice has the same customer, total and items | Open both records. If it is the same sale, link them manually (see "Manual link"). If not, leave. Never create a replacement invoice automatically. |
   | `STUCK_INVOICING` | An attempt was interrupted | Check Invoices for that customer first. If an invoice exists, link it; otherwise a manager sets the order back to Approved. |
   | `BROKEN_LINK` | Order says Invoiced but the invoice is missing or the number differs | Investigate; do not edit until understood. |
   | `DUPLICATE_NUMBER`, `MULTI_FOR_ORDER` | Already-duplicated data | Accounting decision (void/credit note). Out of scope for code. |
   | `UNLINKED_INVOICE` (info) | No order points to it; usually a stand-alone invoice | None unless paired with a POSSIBLE_ORPHAN. |

   The matching in `POSSIBLE_ORPHAN` is a heuristic. It can miss an orphan (e.g. items were edited after invoicing) and it cannot prove two records are the same sale. That is why it reports and never repairs.
3. **Test on a non-live Firebase project** (or the emulator) with the new build: the manual test list in `docs/DEVELOPER-NOTES.md`.
4. **Merge and deploy rules** (see `rules/invoicing.rules.fragment`), tested first with `npm run test:rules` in `tests/` using `NAISI_RULES_PATH=<your real rules>`. The rules are what make old tabs unable to bypass the guarantee: an invoice without an `orderId` field is refused, an order cannot become Invoiced unless its `invoiceId` is `ord_<id>` and that invoice is created in the same commit, and a resume can only happen after a server-time lease has expired.
5. **Only then** consider setting `INVOICING_RESUME_ENABLED = true` in `src/orders.js` (it ships `false`). With it `false`, an order left in "Invoicing" stays blocked and a person must review it; that is the safe default.

## Manual link (for a reconciled orphan)

Done by a person, in the Firebase console, per order, after confirming it is the same sale: set `orders/<id>.status = "Invoiced"`, `invoiceId = <existing invoice doc id>`, `invoiceNo = <its number>`. Do not create or delete invoice documents. Record each decision.

## Old clients: what still happens before the rules are deployed

| Old-tab action | Without the new rules | With the new rules (if they pass the emulator tests) |
|---|---|---|
| Create an invoice (auto id, no `orderId`) | Succeeds | Refused |
| Mark an order Invoiced with an auto invoice id | Succeeds | Refused |
| Bulk invoice twice | Can still duplicate | Refused |

An old tab that is refused will show its own generic error; staff should reload.

## Clock-skew policy for the 10-minute lease

The lease start is a server timestamp; the client compares it with the device clock only to decide whether to *offer* a takeover. A device clock that is behind waits longer (safe). A clock far ahead may attempt a takeover early; that stays safe because the previous attempt's token no longer matches and its commit is refused. The authoritative expiry check belongs in the rules using `request.time`. The lease length (`INVOICING_LEASE_MS`) and the rules constant must be kept equal.

## Rules compatibility checklist (all UNVERIFIED without the real rules)

- Product create no longer writes `unitsPerCase` unless set; edit writes it only if changed; clearing writes `null`. Check any field allowlist/type check.
- Resume needs `Invoicing -> Invoicing`; lock needs `invoicingAttempt` (string) and `invoicingLeaseStartedAt` (server time).
- Invoice create, counter update and order update are one commit; cross-document conditions need `getAfter()` and count toward the rules read limits.
- New fields: `orders.invoicingAttempt`, `orders.invoicingLeaseStartedAt`, `invoices.orderId`. Allowlists must include them.
- Stock receipt (case mode) writes product + ledger together; `unitsPerCase` is written in the same transaction only if it changed.
- Editing an Approved order now writes the order, product balances and `stockMovements` (`type: "order-edited"`) in one transaction.

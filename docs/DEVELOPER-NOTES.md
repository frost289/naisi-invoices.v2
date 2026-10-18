> **RC5 NOTICE (SUPERSEDED-BY-RC5):** where this document disagrees with `docs/RC5-RELEASE-REPORT.md`, the RC5 report wins. In particular: there is NO rollback to RC3 and NO automatic ten-minute invoicing recovery (INVOICING_RESUME_ENABLED=false); use the freeze and stuck-Invoicing procedures in `docs/RC5-DEVELOPER-ROLLOUT-GUIDE.md`. Reconcile/migration preflight now reports invalid and oversized orders (RC4 notes claiming this were wrong at the time).

# Naisi invoices: revised changes (v2 of the patch, 15 Oct 2026)

Base: `908c3c3`. Apply and build:

    git checkout -b claude/fixes-oct-2026 908c3c3
    git am naisi-fixes-v2-2026-10-15.patch
    npm ci && npm run build
    cd tests && npm install && npm test

This replaces the first patch. The first version's notes made claims that were too strong; the corrected statements are below.

## What changed (summary)

1. **Duplicate rows.** A page that arrives after a filter change or refresh is discarded before it touches rows, cursor or "has more" - on **every** paged list (orders, invoices, customers, products, stock movements, expenses, my visits, deliveries) via `createPagedLoadGuard` (`src/ui.js`). Rows are also de-duplicated by id.
2. **One invoice per order, between up-to-date tabs.** Number + invoice + order status are saved in one transaction under the invoice id `ord_<orderId>`. The lock carries an attempt token and a 10-minute lease; a stale attempt cannot commit or release a newer one. Resume of interrupted attempts ships **off**.
3. **Bulk approve / invoice.** One job at a time, buttons locked until close, duplicates removed, re-entry ignored, retry-failed-only kept. An invoice that was saved but whose PDF failed is shown as such, with a "Download PDF" button that never saves again.
4. **Stock.** Repeated product lines are aggregated per product (one read, one write, consistent ledger). Approval uses the order as stored inside the transaction and refuses with `order-changed` if the list was stale. Editing an Approved order is one transaction (order + stock + ledger) that checks status and revision, and re-saving identical content changes nothing. Edit rows keep `productId`.
5. **Cases to packs.** Whole numbers only, product must be a safe integer and at most 1,000,000 packs per receipt; checked in the data layer, not only the form. Stock, ledger and `unitsPerCase` are written in one transaction.

## Corrected claims from v1

- v1: "One invoice per order, guaranteed." **Wrong as stated.** Only between new-version tabs. Old tabs and legacy orphans need the rules and reconciliation in `docs/DEPLOYMENT-AND-RULES.md`.
- v1: "A stuck Invoicing order can be resumed after 2 minutes." **Removed.** Resume is off by default (`INVOICING_RESUME_ENABLED=false`), needs a token and a 10-minute lease, and must not be enabled before reconciliation and rules.
- v1: "Failed attempts no longer burn invoice numbers." Holds for failures *before* the commit. After a successful commit the number is used, even if the PDF then fails (that is correct: the invoice exists).
- v1: "All 18 tests pass" did not test failure at the invoice commit (it failed the lock step). The new tests inject failure specifically at the invoice write.
- Mock tests are not evidence about Firebase rules, the browser, or PDF output.

## Manual test list (browser, non-live project)

1. Select 3 Submitted orders, Approve Selected: window lists them, Start, summary; stock down once each; run again: nothing changes.
2. Order with the same product on two lines (2 + 3): approve, stock down by 5; ledger shows two rows; cancel: stock back by 5.
3. Open an order in two tabs; edit and save in one; save in the other: second shows "changed by someone else".
4. Edit an Approved order (change a qty): product still tracked, stock changes by the difference only; save again: no change.
5. Generate invoices for selected: the buttons that opened the window stay disabled; open a second bulk job: refused.
6. Simulate PDF failure (e.g. block downloads / throw in generatePdf): row says "Invoice saved - PDF failed", Download PDF works, no second invoice, counter did not move.
7. Receive supplier cases: 3 cases x 14 = 42 packs; try 0.5, 0, 1e9 x 1e9: refused with nothing written.
8. Switch the stock-movement product filter quickly several times: list always matches the final filter.
9. Throttle the network, press Load more twice: one request only.
10. Go offline during Generate Invoice: error shown, no invoice; go online and retry: one invoice.

## Known limits

- Rules unverified (not in repo). Resume off. `main.js` handlers are not unit-tested.
- Reconciliation matching is heuristic and read-only.

# RC6.4: changes from RC6.3

Build **RC6.4**, package **6.4.0-rc1**. Built on RC6.3. Branch `claude/fixes-oct-2026`.

**NOT APPROVED FOR PRODUCTION until the Firestore emulator rules suite (`npm run test:rules`) passes on the developer's machine.** The rules file changed, and the emulator download is blocked in the build environment.

This replaces `RC6.4-IMPLEMENTATION-SUMMARY.md`. The expanded expense features described there were withdrawn after the developer's review (28 Oct 2026).

## 1. Orders need a pinned customer location again (owner decision)

RC6.3 let an order be saved for a shop with no pin. That is withdrawn: every order must carry the customer's pin, so deliveries can find the shop.

| Layer | Behaviour |
|---|---|
| Rep visit screen | Choosing "Order" for an unpinned shop shows "Pin this customer's location first". The order form opens once the pin is saved. A **no-order** visit can still be saved without a pin. The "Need a pin" counter, banner and reminder stay. |
| Manager order entry | An unpinned customer is refused with "This customer has no pinned location. Pin it first." |
| Save functions | `submitOrderWithVisit` and `submitOrderAsManager` refuse an unpinned customer and write nothing. |
| Rules | `orderBodyOk` requires valid coordinates equal to the customer's saved pin (the RC6 rule). |
| Older orders | Orders already saved without a location are still tagged "📍 No location" on the manager's order list. |

## 2. Expenses: RC6.3 categories, rep list bug fixed

- **Categories.** Rep: Transport, Meals, Other. Deliverer: Transport, Meals, Fuel, Other. Manager: Transport, Meals, Fuel, **Stock Purchase**, Other. The RC6.4 additions (Internet, Packaging, Supplies, Maintenance, Bank) are withdrawn.
- **Stock Purchase restored for managers.** RC6.4 had removed it, so managers could not record stock costs.
- **Bug fixed.** A rep's expense list showed only the first record: `filter(repMaySeeExpense)` passed the list position as the role. It is now `filter(e => repMaySeeExpense(e))`.
- **Withdrawn.** The separate `stockPurchases` collection (code, rules and indexes) and the optional fields (payee, payment method, receipt reference and so on). They had no screens, and the defaults made reports misleading. They can return in a later release with screens and agreed requirements.
- **Rules.** `expenseFieldsOk` (new in RC6.4) still accepts the optional field names, so any record saved with them stays editable. It refuses any OTHER extra field. Please check on a copy of live data that no existing expense carries fields outside its list, or a manager could not edit that record.

## 3. Verification

| Check | Result |
|---|---|
| Production build | PASS. `dist/build-id.txt` = RC6.4 |
| Unit suite | 31 files, 651 passed, 0 failed |
| Browser suite (mocked backend, Chromium) | 68 passed, 0 failed (E1 to E69, including E54, E57, E58, E60, E66, E68) |
| **Firestore emulator rules suite** | **NOT RUN** (emulator download blocked, HTTP 403). The RC6.4-ORD group replaces RC6.3-ORD. |

Tests changed to match the decisions above: `unit/rc63.test.js` (sections A and C), `unit/maintenance.test.js` (build id, rules hash), `e2e/rc63.e2e.mjs` (E57, E58, E66 title), `rules/invoicing.rules.test.js` (RC6.4-ORD). `unit/rc64Expenses.test.js` was removed with the features it tested.

## 4. Before release

1. `npm ci` in the root and in `tests`, then `npm test`, `npm run test:e2e`, `npm run build`.
2. **`npm run test:rules`**: zero failures, zero skips.
3. Deploy in this order: indexes (wait for READY), hosting, then rules. Confirm the deployed rules hash matches `rules/RC6.4-RULES-SHA256.txt`.
4. Everyone closes and reopens the app and checks it shows **Build RC6.4**.

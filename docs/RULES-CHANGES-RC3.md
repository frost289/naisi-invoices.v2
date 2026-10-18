# What changed in the Firestore rules (RC2 -> RC3)

File: `rules/firestore.rules` (675 lines; RC2 was 395). Exact line diff: `firestore.rules.RC2-to-RC3.diff` (in the evidence pack).

**It is a complete replacement file, not a patch to paste in.** The repository does not contain the rules currently live in Firebase. Before publishing, compare the live rules with the RC2 file (`git show c9de8de:rules/firestore.rules`). If they differ, merge deliberately.

**STATUS: NOT TESTED ON AN EMULATOR.** Do not publish until `run-rules-tests.bat` (170 cases) passes. Publish rules and app together; old app tabs must be closed and reloaded (see RELEASE-CHECKLIST.md).

## Collection by collection
| Collection | Change | Why (decision) |
|---|---|---|
| `config/scheduleHistory` | NEW. Create once by a manager; never edited | 7 |
| `scheduleChanges` | NEW. Append-only, manager, every entry carries actor and server time | 1, 7 |
| `customerMerges` | NEW. Append-only record of each merge | 7, 8 |
| `counterAdjustments` | NEW. Append-only audit of invoice-number adjustments (reason, previous, new, actor, time) | 6 |
| `invoiceNumbers` | NEW. One document per issued number, create-once, so a number can never be reused | 6 |
| `orderCancellations` | NEW. Create-once record per cancelled order (reason, actor, time, stock restored or not) | 2 |
| `counters` (invoice) | Moves only +1 together with its invoice, or by an audited manager adjustment with a reason | 6 |
| `orderCounters` | Moves only +1 together with its order | 3, 6 |
| `invoices` | New `kind` (`order` or `standalone`); stand-alone invoices need explicit id `sa_<uid>_<req>`; number must equal the counter and be registered | 4, 6 |
| `customers` | Created unscheduled (no day, active); only managers change day/active, and only with a matching `scheduleChanges` entry; delete only under a merge lock with a merge record; `mergeLock` field | 1, 7, 8 |
| `orders` | Rep orders as before; manager-entered orders (`m_<uid>_<req>`, no visit); cancellation by update only; Cancelled is final; no deletes; an order in Invoicing cannot be re-pointed by a merge | 2, 3, 8 |
| `visits` | Only reps create visits (managers no longer create visits/orders on their own); a manager may re-point a visit only under a merge lock | 3, 8 |
| `config/depot` | Still NO rule (screen removed) | 5 |
| `config/roles`, `expenses`, `products`, `deliveryAttempts`, `stockMovements`, `locations`, `users` | Unchanged from RC2 | |

## Behaviour changes your team will notice
1. Managers can no longer create arbitrary orders or visits directly; they use "enter order for a rep".
2. Orders can never be deleted; they are cancelled with a reason.
3. A customer cannot be deleted except through a merge.
4. Invoice numbers cannot be typed freely; they are adjusted with a reason.

## Known limits (rules cannot enforce these)
Restored stock quantities on cancellation; the year inside an invoice number; first-hour baseline entries are trusted from a manager. See RC3-OWNER-DECISIONS.md.

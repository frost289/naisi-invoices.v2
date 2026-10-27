# Review of the daily-visits patches against the supplied firestore.rules

Source: the `firestore.rules` file supplied by Andrew on 2026-10-16 (reviewed as-is; not changed, not deployed).
Method: a line-by-line READING of the rules against every read and write the app performs. The Firestore emulator could not be downloaded in the authoring environment (403), so NOTHING below was executed against the rules. "Predicted" means "from reading the rules"; it is not a test result.

VERDICT: NOT SAFE TO DEPLOY. Reading the supplied rules, a rep's first "Order Placed" or "No Order" save is predicted to be REFUSED. One small rules change (stage 1) is needed, and the whole thing must then be confirmed on the emulator.

## 1. The blocking problem (predicted, high confidence)
The app's save first reads the visit (and, for orders, the order) at its own fixed id to detect a retry. On a first save those documents do not exist. The supplied rules:

    visits:  allow read: if isManager() || (isSubmitter() && resource.data.repId == request.auth.uid);
    orders:  allow read: if isManager() || (isSubmitter() && ownsCreatedBy()) || ...;   // resource.data.createdBy

For a document that does not exist `resource` is null, so `resource.data...` is an error, and an error means the read is denied. A manager passes (first operand true) but a rep does not. The transaction then fails and nothing is saved. This affects both patches (0001 reads the visit; 0002 also reads the order).

Fix = rules stage 1 (`rules/proposed/stage1-required.diff`): split `read` into `get` and `list`, and let a rep `get` a not-yet-existing document ONLY at their own id pattern (`v_<uid>_*`, `o_<uid>_*`). Existing documents stay readable only by their owner. Lists are unchanged.
Alternative considered: removing the read from the app. Rejected: without it a double-click or retry could use an order number twice.

## 2. Operation-by-operation (rep = listed in config/roles "submitters")
| # | Operation | Supplied rule | Predicted |
|---|---|---|---|
| 1 | get visits/v_uid_req (first save: missing) | visits read, uses resource.data.repId | DENIED |
| 2 | get orders/o_uid_req (first save: missing) | orders read, ownsCreatedBy() | DENIED |
| 3 | get customers/{id} | customers read: isStaff | allowed |
| 4 | get orderCounters/naisiOrder | read: manager or submitter | allowed |
| 5 | counter write (+1, or first create > 0) | orderCounters create/update | allowed |
| 6 | create orders/o_uid_req (createdBy = uid, status Submitted, valid pin, extra field visitId) | orders create | allowed |
| 7 | create visits/v_uid_req (repId = uid) | visits create | allowed |
| 8 | retry: get existing own visit / own order | visits read / ownsCreatedBy | allowed |
| 9 | rep query visits where repId = uid and date = d | visits read (query constraint matches) | allowed |
| 10 | rep "My visits" page: repId + orderBy createdAt | same, index already needed before these patches | allowed (index not supplied; unchanged) |
| 11 | manager query visits by date range | isManager | allowed |
| 12 | read config/roles (rep list for the report) | any signed-in user | allowed |
| 13 | manager sets assignedDay / assignedDayChangedAt / active | customers update (pin must stay valid) | allowed |
| 14 | update or delete a visit | `if false` | denied (the app never does this) |
Rows 1 and 2 make the feature unusable for reps until stage 1 is deployed.

## 3. Gaps that do not block, but matter (stage 2, optional hardening)
- The rules do not validate visits: a made-up reason, "Other" without an explanation, an automatic id, someone else's repEmail, a client-set time, or an "Order Placed" visit with no order are all accepted. The checks exist in the app only. Old browser tabs and any API caller bypass them.
- Any rep may update any customer field, including the weekly visit day, which would change everyone's list and the reports.
- The rules do not stop the same request id being used for an order without its visit (no linkage).
- Stage 2 (`rules/proposed/stage2-hardening.diff`, apply after stage 1) adds: reason list and explanation checks, id = `v_<uid>_<requestId>`, repEmail = login email, createdAt = request.time, order/visit linkage via existsAfter/getAfter, and manager-only changes to assignedDay. Deploy stage 2 only after every rep is on the new app: older versions write automatic ids and would then be refused.
- Related, not part of this feature: invoices, stock and counters are manager-only operations the rules permit; protections added in revision 2 (one invoice per order, ord_ ids, locks) are client-side only, because the rules do not enforce them.

## 4. New fields and permissions to confirm on the emulator
visits: schemaVersion, requestId, customerId, customerName, repId, repEmail, date, scheduledDay, wasScheduled, outcome ("Order Placed" / "No Order"), reasonNoOrder, reasonNotes, orderId, orderNo, orderValue, createdAt. orders: visitId. customers: assignedDayChangedAt. Transaction: reads of a missing visit and order at deterministic ids (needs stage 1), one commit writing counter + order + visit. Access calls per request: roles lookup, plus existsAfter/getAfter in stage 2: well under the 20-per-transaction limit, to be confirmed. Indexes: none new.

## 5. How to test (someone with Java and network access)
    cd tests && npm install
    # as supplied: expect the "AS SUPPLIED" test to pass (i.e. the denial is real)
    NAISI_RULES_PATH=/path/to/firestore.rules NAISI_RULES_STAGE=0 npm run test:rules
    # after stage 1:
    NAISI_RULES_PATH=/path/to/stage1/firestore.rules NAISI_RULES_STAGE=1 npm run test:rules
    # after stage 1 + 2:
    NAISI_RULES_PATH=/path/to/stage2/firestore.rules NAISI_RULES_STAGE=2 npm run test:rules
The older "invoicing rules" tests in the same file assert stricter behaviour than the supplied rules enforce; they are expected to fail against it and show the gaps listed in section 3. Status of everything here: NOT RUN (BLOCKED: emulator unavailable).

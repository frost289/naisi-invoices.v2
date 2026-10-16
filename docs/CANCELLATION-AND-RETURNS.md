# Cancellation and the returns/credit boundary (decision 2)

**Pre-invoice cancellation** (managers only): order statuses Submitted/Approved/Invoicing-free states. A reason is required; actor and server time are saved in `orderCancellations/{orderId}`. If the order was Approved and stock had been deducted, the stock is restored in the same transaction, once: the cancellation record can be created only once, so retries, double clicks and concurrent cancels cannot restore twice. The order and the stock ledger remain.

**Invoiced or delivered orders cannot be cancelled this way.** Goods may already have left and a fiscal invoice number exists (numbers are never reused). Those need a returns / credit-note process, which is NOT built in RC3. Until it is, the owner must handle them outside the app (record it, keep the invoice). This is a deliberate boundary, not an oversight.

Known limits: rules cannot verify the restored quantities (use `tools/reconcile.mjs`); a cancelled order's visit still counts as an order taken.

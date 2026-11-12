# Waiter ordering

The `/waiter` route uses a compact POS-style menu and the shared `OrderMenuItem`
component. POS checkout, billing and cash controls remain separate.

- Select a restaurant table or takeaway before adding items.
- Each selection keeps its own unsent draft in this browser tab's session storage.
- Menu search, categories and dietary filters combine. Unavailable items cannot be added.
- Item quantity and preparation notes apply only to unsent items.
- Send to Kitchen creates a new order containing only the unsent items. An unpaid
  table order, including a served order, is linked as the add-on parent.
- The order response updates the queue immediately. Socket events, reconnect
  refresh and a 30-second refresh keep order/payment state current.
- Request Bill is available for a selected table once all unpaid orders are
  prepared/served and there are no unsent items. It uses the existing billing alert.
- Waiters cannot take payments, redeem loyalty, discount, cancel, edit sent items,
  transfer tables or change kitchen status. Those remain authorized staff actions.
- This release uses all existing restaurant tables. It does not introduce an
  admin-maintained waiter/table assignment model or new override permissions.

## Retry safety

`CounterOrderCreate.submission_token` is optional for compatibility with existing
counter clients. The waiter supplies it. A tenant-and-user-scoped deterministic
MongoDB `_id` prevents concurrent inserts from creating duplicate orders. A saved
payload hash rejects reuse of the token for different contents. No index migration
is needed; MongoDB's existing unique `_id` index enforces the constraint.

An ambiguous failure retains the payload/token and locks draft editing until retry.
This is not offline ordering: the app never claims success before server confirmation.
Unsent customer details are tab-local and cleared on successful submission/logout.
Backend and frontend must both be deployed for retry protection and staff bill requests.

## Validation

- `python3 -m unittest tests.test_waiter_ordering` uses mocked storage and events;
  it does not send messages or connect to a production database.
- `tests/waiter_ui.cjs` uses Playwright and mocked APIs against localhost:3000.
  It covers 390/768/1440 layouts, table drafts, filters, notes, retry identity,
  sent/unsent separation, bill requests and shared POS cart behavior.
- Before release, perform a staging waiter-to-kitchen-to-billing flow with two
  real browsers, including a lost connection and a payment completed elsewhere.

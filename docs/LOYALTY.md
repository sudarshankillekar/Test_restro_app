# Dineflo Coins

## Rules

- Accounts are scoped to a restaurant and normalized Indian mobile number.
- Each completed bill earns 8 coins per complete Rs.100 of the final amount paid,
  after discounts and coin redemption. Rs.250 earns 16 coins; leftover rupees do
  not accumulate across bills. Coins carry forward without expiry.
- One coin is worth Rs.1. A pre-payment balance of 200 or more unlocks redemption.
  Any whole number of coins can then be used, capped by the balance and bill total.
- Coins earned on this bill cannot fund this same bill's redemption.
- No valid, unambiguous phone means no loyalty credit. Staff can enter and check
  the correct phone in payment confirmation. This explicitly selected phone also
  becomes the WhatsApp bill recipient. No lookup by customer name or table history.
- This starts with new payments; it does not backfill old purchases.

## Staff workflow

Billing Counter > Dineflo Coins opens balance and paginated coin/redemption history.
Complete Payment includes the same lookup and a coins-to-redeem input. Lookup is
required after changing a phone. POS supports the same workflow through Dineflo
Coins in its cart. The server rechecks the balance when payment commits.

Only authenticated admin, billing, kitchen_billing and pos staff can look up
loyalty accounts for their own restaurant. Redemption requires staff confirmation;
phone ownership is not independently verified with an OTP.

## Accounting and operations

Loyalty payment, account balance, ledger and order changes use MongoDB transactions.
A replica set or sharded cluster is required (including MongoDB Atlas); standalone
MongoDB does not support this workflow. No best-effort fallback is used for coin
transactions. `_id` values enforce one account per restaurant/phone and one ledger
entry per payment/event. History indexes are created at server startup.

Deleting a loyalty bill reverses earned coins and returns redeemed coins atomically
with the existing deletion audit. If those earned coins were already spent,
the reversal may create a negative balance; future earnings offset it. Monetary
or phone edits to a completed loyalty POS bill require deletion with a reason
and a corrected bill so ledger history remains consistent.

WhatsApp uses the existing Evolution bill delivery. Its caption includes earned,
redeemed and closing balance after that bill. Delivery depends on Evolution being
configured and reachable; ambiguous sends are not retried automatically. No extra
message is sent separately, avoiding duplicate balance/bill notifications.

POS checkout tokens make an unchanged retry return the same bill rather than
create a second purchase. The browser keeps the token for a failed attempt until
success or the checkout contents change.

## Verification

`python3 -m unittest tests.test_loyalty tests.test_whatsapp_billing_local`

Real transaction tests require a disposable local MongoDB replica set named
`loyaltyTest` at `127.0.0.1:27029`. Run with `LOYALTY_TEST_MONGO=1`.
Tests create and remove isolated `loyalty_test_*` databases and never send WhatsApp.

`node tests/loyalty_ui.cjs` checks desktop/mobile billing with mocked API responses.
Optional `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_CHANNEL` select an installed runtime.

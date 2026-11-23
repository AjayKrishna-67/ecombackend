# Adloggs Hyperlocal Delivery — Documentation

## Overview

[Adloggs](https://adloggs.com) is a third-party rider-delivery service (like Shiprocket
Quick): we create a delivery order via their partner REST API, an Adloggs rider picks up
from the store and delivers to the customer, and Adloggs pushes status updates back to us
via webhook. Rates are distance-based between the **store pickup point** (configured on
the shipping method — see below) and the **customer's map pin** (Address custom fields
`latitude`/`longitude`).

- Dev API: `https://dev.adloggs.com` · Live API: `https://app.adloggs.com`
- Auth: `x-api-key` header, key issued by Adloggs
- Payment: always sent as **Online** (prepaid) — see Fulfillment below

## Directory structure

```
src/plugins/Shipping/adloggs/
├── adloggs.plugin.ts               # Plugin: custom fields, calculator, controller, API
├── constants.ts                    # DI token, logger context, webhook header name
├── types.ts                        # API types, AdloggsStatus enum, status labels
├── ADLOGGS_DOCUMENTATION.md        # This file
├── services/
│   ├── adloggs.service.ts          # IO client: create / availability / status / cancel / wallet
│   ├── adloggs-mapper.ts           # Pure mapping: payload build, phone/money/date, state chains
│   └── adloggs-mapper.spec.ts      # Unit tests for the mapper
├── shipping/
│   └── adloggs-calculator.ts       # "Adloggs live rates (distance-based)" checkout calculator
├── fulfillment/
│   ├── adloggs-fulfillment.service.ts     # Create/cancel/sync + status application
│   └── adloggs-fulfillment.subscriber.ts  # Event wiring (create / cancel echoes)
├── api/
│   ├── adloggs-webhook.controller.ts # POST /adloggs/webhook (status pushes from Adloggs)
│   ├── api-extensions.ts             # Admin GraphQL schema
│   └── adloggs-admin.resolver.ts     # adloggsWalletBalance / syncAdloggsStatus
├── dashboard/                        # React dashboard: "Adloggs Delivery" order card
└── ui/                               # Angular admin: same card (legacy /admin)
```

## How it works

### 1. Quoting (shop checkout)

The **`adloggs-calculator`** shipping calculator:

1. Reads the store pickup point from **its own `pickupConfig` argument** — the
   **Pickup Store map picker** shown on the shipping-method form when you select the
   Adloggs calculator. One shipping method = one store.
2. Reads the customer's coordinates from the shipping address custom fields
   (`latitude`/`longitude` — the map pin set in the PWA). **No pin** (typical for admin
   draft orders): the pincode (+ city) is geocoded server-side via Nominatim (5s timeout,
   cached per pincode) and the quote is flagged `metadata.approximate: true` — the exact
   rider distance is settled by Adloggs at pickup.
3. Calls the Adloggs availability API and returns `estimated_price` (₹ → paise) as the
   shipping charge, with `etaMinutes`/`distanceKm` in the quote metadata.

The method silently drops out of `eligibleShippingMethods` when: the method's pickup
arguments are incomplete, the address has neither a map pin nor a geocodable pincode, Adloggs reports
unserviceable/distance-too-long, or the API is unreachable. Transport failures start a
**60s cooldown** during which no further live calls are made, so an Adloggs outage
(observed: 30s gateway hangs on dev) cannot stall every checkout render.

### 2. Fulfillment (admin)

- The shipping method must use the **KaaiKani Fulfillment** handler
  (delivery-strategy-router). Its dropdown now offers:
  **Own Delivery Fleet · Shiprocket Quick · Adloggs · Take Away (Manual)**.
- Choosing **Adloggs** stamps `customFields.fulfillmentType = 'adloggs'` on the
  fulfillment. The event subscriber then (post-commit, so a slow Adloggs call never
  holds the DB transaction):
  1. Builds the create-order payload — pickup block from the Adloggs calculator's
     arguments (the order's own shipping line when it used the Adloggs method;
     otherwise an Adloggs shipping method on the order's channel — the store **nearest
     the customer's map pin** if there are several — so **any** order can be dispatched
     via Adloggs even while checkout quoting is down), delivery block
     from the shipping address + map pin (pincode-geocoded when there is no pin, with a
     warning in the log), items/weight from the order lines
     (`resolveVariantMeasures`, 500 g default per unmeasured line, 0.5 kg minimum),
     `order_category: "Grocery"`, `pickup_date_time` = now + 15 min (IST).
  2. **Always prepaid**: `payment_type: "Online"`, `collectible_amount: 0` regardless of
     how the customer paid — the Adloggs account is not enabled for COD (their API
     answers "COD orders not allowed") and KaaiKani collects cash itself; the rider
     never handles money.
  3. Stores `order_uuid`, `trackUrl` and `fee` on the fulfillment custom fields.
- **Failures are ambiguous on purpose**: Adloggs has returned `"Internal error"` while
  still creating the order (verified on dev — no rollback on their side). So a failed
  create is stored on `adloggsError` (shown on the order card) and **never auto-retried**.
  Recovery: the card's **Retry** button, or the first webhook for that
  `partner_order_id`, which stamps the recovered uuid automatically.

### 3. Status webhook — `POST /adloggs/webhook`

Adloggs pushes every status change. The controller authenticates via the
`x-webhook-token` header (shared secret from `ADLOGGS_WEBHOOK_TOKEN`; timing-safe
compare; endpoint disabled when unset), finds the fulfillment by `order_uuid` (fallback:
`partner_order_id` = order code), stores status + rider details, and walks the
fulfillment through the implied state transitions. Order state follows automatically via
the delivery-strategy-router's `DeliveryFulfillmentStateSubscriber`.

| Adloggs status | Vendure effect |
|---|---|
| 2 Pending / 3 Assigned / 11 Arrived at pickup | store status + rider name/phone |
| 4 Picked up | fulfillment → **Shipped** |
| 9 Out for delivery / 8 Arrived at delivery | fulfillment → **OutforDelivery** (order follows) |
| 5 Delivered | fulfillment → **Delivered** (order → Delivered/PartiallyDelivered) |
| 6 Cancelled | fulfillment → **Cancelled** (only legal from Pending/Shipped) |
| 13 Return initiated / 14 RTO delivered | status stored + warning log — **admin resolves manually** (no clean Vendure equivalent; from OutforDelivery the state machine only allows → Delivered) |

Webhook replies: `401` bad token · `200 {ignored:true}` unknown order (so Adloggs stops
retrying) · `200 {success:true}` applied. Updates are idempotent — no dedup table or
worker needed.

**Out-of-order delivery**: webhooks can arrive late or reordered. Each status has a
progress rank (`ADLOGGS_STATUS_RANK`); an update ranked *below* the stored
`adloggsStatus` (e.g. a late "Picked up" after "Delivered") is ignored and logged, so the
card and the fulfillment never walk backwards. Same-rank replays are harmless no-ops.

### 4. Cancellation

- Cancelling the Vendure **order** or the individual **fulfillment** automatically calls
  the Adloggs cancel API — skipped when `adloggsStatus` is already terminal
  (Delivered/Cancelled/Return/RTO), which also prevents echoing a webhook-initiated
  cancellation back to Adloggs.
- Adloggs refuses cancellation **after pickup** ("Order already picked up.") — that
  refusal is logged; coordinate with Adloggs directly in that case.

### 5. Order page card (dashboard + Angular admin)

Both admins show an **"Adloggs Delivery"** card on the order-detail page for every
Adloggs fulfillment: status badge, rider name/phone, delivery fee, order uuid, live
tracking link (`trackUrl`), stored error if any, and a **Sync / Retry** button
(`syncAdloggsStatus`). The dashboard card also shows the Adloggs wallet balance when the
account has one.

## Configuration & custom fields

### Shipping method — Pickup Store map picker (one method per store)

Selecting the **Adloggs live rates** calculator on a shipping method renders the
**Pickup Store** picker (dashboard `dashboard/pickup-config-input.tsx`, Angular
`ui/pickup-config-input.component.ts`) — the same map UX as the Take Away plugin:

- **Map on top** — click/drag to pin (Google Maps JS with `GOOGLE_MAPS_API_KEY`, read via
  the existing `googleMapsApiKey` admin query), or **Locate pincode** / **Use GPS**
  (works keyless via Nominatim + an embed preview).
- **Typed below the map** — Pickup Contact Name, Pickup Contact Phone, Pickup Address.
- **Auto-filled from the pin** (every pin reverse-geocodes: Google Geocoder, Nominatim
  fallback) — latitude/longitude, pincode, city, state; the address is also filled when
  still empty. Pincode/city/state stay editable in case the geocoder gets one wrong.

Everything is stored as **one JSON string** in the calculator's `pickupConfig` arg —
`{ name, phone, address, lat, long, pincode, city, state }` — inside the shipping
method's calculator config, so **no schema change**. The backend (`pickupConfigFromArgs`)
validates completeness and names any missing field; the fulfillment flow reads the arg
back from the order's shipping line (or, for orders shipped with another method, from any
Adloggs shipping method on the order's channel).

### Fulfillment custom fields (admin-API readable, read-only; written by the plugin)

| Field | Meaning |
|---|---|
| `adloggsOrderUuid` | Adloggs order id (used for status/cancel) |
| `adloggsStatus` | Last known Adloggs status id (see table above) |
| `adloggsTrackUrl` | Public live-tracking URL |
| `adloggsRiderName` / `adloggsRiderPhone` | Assigned rider |
| `adloggsFee` | Delivery fee (₹) from the create response |
| `adloggsError` | Last creation/sync error (empty when healthy) |

**Migration**: `src/migrations/1787737881776-adloggs-fields.ts` (pure nullable
ADD COLUMNs on `fulfillment` only). The generator also emitted the usual bogus drift
(asset.name DROP, order_modification index drops) plus an unrelated invoiceNo unique
index — stripped per policy. Back up before running on any new environment.

## GraphQL API (Admin)

| Operation | Purpose |
|---|---|
| `adloggsWalletBalance: AdloggsWalletBalance!` | Wallet balance for the configured key (`enabled: false` when the account has no wallet) |
| `syncAdloggsStatus(fulfillmentId: ID!): AdloggsSyncResult!` | Reconcile one fulfillment: fetch + apply the live status, or retry a failed creation |

Everything else (the order card data) is read through the standard `order` query — the
fulfillment custom fields are deliberately non-internal so no extra lookup API exists.

## Setup checklist

1. **Env vars** (`.env`):
   - `ADLOGGS_HOST` — `https://dev.adloggs.com` (dev) / `https://app.adloggs.com` (live)
   - `ADLOGGS_API_KEY` — key issued by Adloggs
   - `ADLOGGS_WEBHOOK_TOKEN` — generate with `openssl rand -hex 24`
2. **Migration** — `bun run migration:run` (see Configuration above).
3. **Register the webhook in the Adloggs dashboard** (self-service —
   *Developer → Webhook* at dev.adloggs.com / app.adloggs.com):
   - Webhook URL: `https://<public-api-host>/adloggs/webhook`
   - Header Name: `x-webhook-token`
   - Header Value: the `ADLOGGS_WEBHOOK_TOKEN` value from `.env`
   Save, then use *Developer → Test webhook* to fire a sample and check the server logs
   for `[AdloggsPlugin] Adloggs webhook:`. The header value in their dashboard and the
   env var on our server are the **two halves of one shared secret** — Adloggs sends it,
   we verify it; anything without it gets 401.
4. **Shipping method** (per channel, one per store):
   - Calculator: **Adloggs live rates (distance-based)** — pin the store on the map,
     type the contact name/phone (and address if you want to override the auto-fill)
   - Fulfillment handler: **KaaiKani Fulfillment**
5. **Storefront**: delivery addresses must carry the `latitude`/`longitude` custom
   fields (map pin) — already the case for the KaaiKani PWA.

## Known Adloggs-side issues (verified on dev, 26 Aug 2026)

1. **Availability API hangs** — every valid request to
   `/aa/oporder/v1.2/service/availability` timed out with a gateway 504 (~30s);
   validation errors return instantly, so the endpoint is alive but its downstream
   search hangs. Until Adloggs fixes this, the checkout calculator will keep timing out
   (8s) and the shipping method will not appear — the failure cooldown keeps checkout
   fast. **Reported to Adloggs.**
2. **Create can error yet still create** — `"Internal error"`
   (`ER_DATA_TOO_LONG` on their `dp_map_dtl` column) with the order still created, and
   the error body leaks their raw SQL/config. This is why creation failures are treated
   as ambiguous (stored, never auto-retried) and why the webhook does
   partner_order_id-based uuid recovery. **Reported to Adloggs.**

## Troubleshooting

- **Method missing from `eligibleShippingMethods`** — the method's Pickup Store is
  incomplete (no pin, or a blank name/phone/pincode/city/state); address has no map pin; Adloggs unserviceable for the
  distance; API down (check `[AdloggsPlugin]` log lines — every skip states its
  reason); or inside the 60s failure cooldown after an outage.
- **Fulfillment created but card shows "Failed"** — the create call failed;
  `adloggsError` holds the reason. Check the Adloggs panel for a ghost order before
  pressing **Retry**.
- **Statuses not updating** — webhook not registered with Adloggs, wrong token, or the
  server is unreachable from Adloggs. Use **Sync** on the card as a manual fallback;
  `[AdloggsPlugin]` logs every webhook received.
- **"Wallet not enabled"** — the Adloggs account has no wallet; ask Adloggs to enable
  it if you want balance visibility.
- **Order cancelled in KaaiKani but rider still came** — the order was already picked
  up when the cancel ran (Adloggs refuses post-pickup cancels; the refusal is in the
  logs). Coordinate with Adloggs support.

# Shiprocket Quick (Hyperlocal) — Documentation

## Overview

Shiprocket Quick is Shiprocket's hyperlocal delivery service: rates are calculated from the
**distance between the pickup address and the delivery address** (latitude/longitude), and
delivery is performed by an assigned rider. This document covers the Quick integration; the
international integration is documented separately in
[`international/README.md`](international/README.md).

> **One plugin.** Quick and International are a single merged **`ShiprocketPlugin`**
> ([`shiprocket.plugin.ts`](shiprocket.plugin.ts)), registered once in
> `src/vendure-config-plugins.ts`:
>
> ```ts
> ShiprocketPlugin.init({
>   email: process.env.SHIPROCKET_EMAIL,
>   password: process.env.SHIPROCKET_PASSWORD,
> })
> ```
>
> Both integrations share one auth-token layer (a single cached Shiprocket login) and one set
> of Fulfillment custom fields.

## Directory structure

```
src/plugins/Shipping/shiprocket/
├── shiprocket.plugin.ts            # Single merged plugin (Quick + International)
├── constants.ts                    # API base URL, DI token, logger context
├── types.ts                        # Rate/order/tracking types (Quick)
├── services/
│   └── ship-rocket.ts              # Shared IO service: auth token (Redis-cached),
│                                   # pickup addresses, quick rates, create/cancel
│                                   # order, order details, AWB assign, tracking
├── shipping/
│   └── shiprocket-quick-calculator.ts   # "Shiprocket Quick live rates (distance-based)"
├── fulfillment/
│   ├── shiprocket-quick-fulfillment.service.ts     # Creates the Quick order in Shiprocket
│   └── shiprocket-quick-fulfillment.subscriber.ts  # Event wiring (create / cancel)
├── api/
│   ├── api-extensions.ts           # Admin + shop GraphQL schema (Quick)
│   ├── ship-rocket-admin.resolver.ts
│   └── ship-rocket-shop.resolver.ts
├── dashboard/                      # React dashboard (single entry for the whole plugin)
│   ├── index.tsx                   # Registers intl route/block + Quick order block
│   ├── order-shiprocket-quick-block.tsx  # Collapsible Quick card (Refresh, Ship Now, tracking)
│   └── quick-queries.ts
├── ui/                             # Angular admin-ui (legacy /admin)
│   ├── providers.ts
│   └── shiprocket-fulfillment-detail.component.ts  # Same card for the Angular admin
└── international/                  # International integration (see its README)
```

## How it works

### 1. Quoting (shop checkout)

- The customer's shipping address must carry coordinates in the Address custom fields
  `latitude` / `longitude` (defined in `src/vendure-config-custom-fields.ts`).
- The **`shiprocket-quick-calculator`** shipping calculator:
  1. Loads all pickup addresses from Shiprocket (`GET /v1/external/settings/company/pickup`).
  2. Selects the pickup address: if the calculator's **Priority Pincodes** argument is set
     (comma-separated, e.g. `641038,625018`), ONLY addresses in those pincodes are considered;
     the nearest by Haversine distance to the delivery point wins. With no priority pincodes,
     the nearest of all active addresses is used.
  3. Calls the serviceability endpoint (`GET /v1/external/courier/serviceability/` with
     `is_new_hyperlocal=1` and both coordinate pairs) and returns the rate.
- The quote's `metadata` includes `courierName`, `etd`, `etdHours`, `distance`,
  `pickupLocation`, `pickupAddressId`.

### 2. Fulfillment (admin)

- The shipping method must use the **KaaiKani Fulfillment** handler (`kaaikani-fulfillment`,
  from the delivery-strategy-router plugin). Its dropdown offers:
  **Own Delivery Fleet · Shiprocket Quick · Take Away (Manual)**.
- Choosing **Shiprocket Quick** stamps `customFields.fulfillmentType = 'shiprocket-quick'`
  on the fulfillment. The event subscriber picks that up and:
  1. Verifies the order's shipping line uses the Quick calculator.
  2. Re-runs nearest-pickup selection (honouring the method's priority pincodes).
  3. Creates the order in Shiprocket — `POST /v1/external/orders/create/adhoc` with
     `shipping_method: "HL"`, an auto-generated `order_id` (`HL-<timestamp>-<rand>`), and
     `channel_id` from `SHIPROCKET_CHANNEL_ID` (optional env var).
  4. Stores the result on the fulfillment custom fields (see below).
- **Cancellation**: cancelling the Vendure order (or the individual fulfillment) automatically
  cancels the Shiprocket order (`POST /v1/external/orders/cancel`, payload `{ ids: [...] }`).

### 3. Order page cards (dashboard + Angular admin)

Both the React dashboard and the Angular admin show a collapsible **"Shiprocket Quick"** card
per Shiprocket order on the order-detail page:

- Live data fetched via `getShiprocketDetailsByVendureOrder` (which also **auto-syncs**: AWB /
  courier / status are written back to the fulfillment, and the fulfillment auto-transitions
  to **Shipped** when AWB + courier are assigned and **Delivered** when Shiprocket reports
  delivered).
- **Refresh** re-fetches from Shiprocket.
- **Ship Now** triggers AWB / rider assignment (`POST /v1/external/courier/assign/awb`).
  For hyperlocal, the response does NOT contain the AWB — the AWB is generated asynchronously
  once a rider accepts. Use Refresh / tracking to see it appear.
- **View tracking** shows the live timeline (see next section).

### 4. Tracking

Quick tracking uses **track-by-shipment-id** —
`GET /v1/external/courier/track/shipment/{shipment_id}` — deliberately, because hyperlocal
shipments have **no AWB until a rider is assigned**, while the shipment id exists from order
creation. (International uses track-by-AWB instead, where the AWB is immediate.)

Live-verified response shape (differs from track-by-AWB!): the payload is **keyed by the
shipment id** —

```json
{ "<shipmentId>": { "tracking_data": { "shipment_track": [...],
                                        "shipment_track_activities": [...],
                                        "track_url": "...",
                                        "error": "Ohh! This AWB has been cancelled." } } }
```

`error` is set when there is nothing to track (e.g. cancelled shipment) and is surfaced in the
UI. Tracking responses are cached for 3 minutes (Redis) to respect Shiprocket's rate limits.

## Custom fields

All Shiprocket Fulfillment custom fields are defined once in `shiprocket.plugin.ts` and shared
by Quick and International (string columns — Shiprocket's numeric ids are stored as strings):

| Field | Used by Quick as |
|---|---|
| `shiprocketOrderId` | Shiprocket order id (numeric, stored as string) |
| `shiprocketChannelOrderId` | The auto-generated `HL-...` id sent to Shiprocket |
| `shiprocketShipmentId` | Shipment id (used for Ship Now + tracking) |
| `shiprocketStatus` | Last known Shiprocket status |
| `shiprocketAwb` | AWB code (**note: not** `shiprocketAwbCode` — that column was dropped) |
| `shiprocketCourierName` | Courier / rider service |
| `pickupLocation` | Quick-only: selected pickup location tag |
| `shiprocketCourierId`, `shiprocketTrackUrl`, `shiprocketInvoiceUrl`, `shiprocketLength/Breadth/Height/WeightGrams`, `shiprocketLastSyncedAt` | International only |

Address custom fields `latitude` / `longitude` live in `src/vendure-config-custom-fields.ts`.

**Migration**: any new deployment needs `npm run migration:generate -- <name>` +
`npm run migration:run`. Review the generated file before running (never `synchronize: true`;
back up first — MySQL cannot roll back DDL, and TypeORM sometimes generates drops that MySQL
rejects or that would lose data).

## GraphQL API (Quick)

### Admin API

| Operation | Purpose |
|---|---|
| `testShiprocketAuth: Boolean!` | Verify credentials / token |
| `getShiprocketPickupAddresses: [PickupAddress!]!` | All pickup addresses from the Shiprocket account |
| `getShiprocketQuickRates(input: QuickRateInput!): [QuickRate!]!` | Distance-based rate check |
| `getShiprocketOrderDetails(orderId: Int!): ShiprocketOrderDetails` | One Shiprocket order (`orders/show`) |
| `getShiprocketDetailsByVendureOrder(vendureOrderId: ID!): [ShiprocketOrderDetails!]!` | All Quick orders for a Vendure order + auto-sync/auto-transition |
| `getShiprocketQuickTracking(shipmentId: Int!): ShiprocketQuickTracking` | Live tracking timeline (works pre-AWB); includes `error` |
| `cancelShiprocketQuickOrder(orderIds: [Int!]!): Boolean!` | Cancel Shiprocket orders |
| `assignShiprocketAwb(shipmentId: Int!, courierId: Int): AssignAwbResult!` | Ship Now (rider/AWB assignment) |

### Shop API

| Operation | Purpose |
|---|---|
| `getShippingOptions(input: ShippingRateInput!): [ShippingOption!]!` | Standard (pincode-based) Shiprocket rates — kept for storefront use; the standard *calculator* was removed |

Quick quoting on the storefront goes through the normal checkout flow:
`setOrderShippingAddress` (with `customFields.latitude/longitude`) → `eligibleShippingMethods`.

## Setup checklist

1. **Env vars** (`.env`): `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD`, optional
   `SHIPROCKET_CHANNEL_ID` (Shiprocket-side channel id for created orders).
2. **Migration** — see Custom fields above.
3. **Shipping method** (per Vendure channel — switch the channel selector first):
   - Calculator: **Shiprocket Quick live rates (distance-based)**
     (optional *Priority Pincodes* argument)
   - Fulfillment handler: **KaaiKani Fulfillment**
4. **Shiprocket panel**: pickup addresses must be active and have coordinates; the
   `pickup_location` name is case-sensitive.
5. **Storefront**: save delivery addresses with `latitude`/`longitude` custom fields.

## Troubleshooting

- **Method missing from `eligibleShippingMethods`** — address has no lat/long; no pickup
  address matches the priority pincodes; the method isn't assigned to the request's channel
  (`vendure-token`); or serviceability returned nothing. The `[ShiprocketPlugin]` server log
  lines state the exact reason.
- **Ship Now succeeded but no AWB** — normal for hyperlocal: the AWB appears only after a
  rider accepts. Check tracking / Refresh after a minute.
- **Tracking says "AWB has been cancelled"** — the Shiprocket order/shipment was cancelled;
  that message comes from Shiprocket's `error` field.
- **Duplicate `order_id` errors when testing via Postman** — Shiprocket requires a unique
  `order_id` per creation attempt.
- **Startup warning about `REL_...` indexes / `asset.name`** — known harmless schema drift;
  never apply those drops (see the migration notes above).

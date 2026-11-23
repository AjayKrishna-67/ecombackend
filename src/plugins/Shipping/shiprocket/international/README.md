# Shiprocket International Shipping

International shipping via the [Shiprocket](https://www.shiprocket.in/) API, end to end:

1. **Quoting** — live courier rates at checkout. Each Shiprocket courier is its own Vendure shipping
   method; the customer is charged the **courier's rate + a configurable markup**, converted to the
   order currency.
2. **Fulfillment** — fulfilling the order creates the real Shiprocket order (`create/adhoc`).
3. **Tracking** — sync status/AWB from Shiprocket and show a live tracking timeline in the admin
   order page and (owner-only) on the storefront.

> Testing guide: [TESTING.md](./TESTING.md)

```
checkout      eligibleShippingMethods → checker + calculator → courier price shown
place order   customer picks a courier method, pays
fulfil        admin fulfils with the "Shiprocket International" handler → SR order created
ship          courier + AWB assigned in the Shiprocket panel → "Sync from Shiprocket"
track         live timeline (courier/track/awb) in admin block + shop API
cancel        cancelling the fulfillment cancels the SR order; re-fulfil = new SR order
```

---

# Part 1 — Quoting

## How it works

```
checkout (international order)
  → ShippingEligibilityChecker  "Shiprocket International (destination eligible)"
       country ≠ IN  AND  pickup pincode configured ?           ── no ─► method skipped
  → ShippingCalculator          "Shiprocket International Rate"
       weight + box dims → Shiprocket serviceability API
       find courier by name → price = courier rate + markup     ── not found / no price ─► method hidden
```

You create **one shipping method per courier** (SRX Premium, India Post…), each bound to a courier
by name and given its own markup settings. The available couriers **change with weight and
destination** — configure names that actually appear for the weights you ship.

## Pricing formula

```
weightGrams = Σ(variant.weight × qty)                       // ProductVariant `weight` custom field (grams)
(L,B,H)     = box-bracket row matched to weightGrams          // from the settings page table
courier     = Shiprocket response courier whose name == courierName  (case-insensitive)
              → not found, or returns no price ⇒ METHOD HIDDEN

baseINR     = courier.rate.rate ?? courier.rate.total     (must be > 0)
              // rate.rate is the full freight incl. surcharges (e.g. Remote Area Surcharge);
              // rate.total is the fallback India Post couriers populate (there total == rate.rate)
markupINR   = ceil(weightGrams ÷ grams) × gramsPerAmount      // the slab markup
totalINR    = baseINR + markupINR + staticCharge
finalPrice  = round( totalINR ÷ fxRate × 100 )               // order-currency minor units (paise/cents)

// Shiprocket's import tariff (e.g. 15% duty for the HSN) is recorded in metadata.importTariff but
// NOT charged — it's a customs duty the recipient pays at destination.
```

The quote metadata also carries `eddFrom`/`eddTo` (estimated delivery window in days, e.g. 10–12),
`etd`, `weightGrams`, the chosen `box`, and a full price `breakdown`.

## Configuration

### A. Account & boxes — Settings → Shiprocket International (per channel)

| Field | Notes |
|---|---|
| **Pickup pincode** | Your dispatch origin, e.g. `625018`. Required, or no method shows. |
| **Pickup location name** | The Shiprocket pickup-address **nickname** (e.g. `warehouse`), used by the order-create API at fulfillment. Must match a pickup address saved in your Shiprocket panel. |
| **FX rate** | INR per **1 USD**. Use `1` to treat the rate as already in the order currency, or e.g. `83` to convert INR → USD. |
| **Box dimensions table** | Weight → L/B/H (cm). A cart uses the first row whose "up to weight" it doesn't exceed; heavier carts use the largest row. Add as many rows as you need. |

#### Entering box brackets

Each row is the **upper limit** of a bracket, in **grams** — not a range. The lower bound is
automatic (where the previous row ended). So boxes of `0–2 kg → 20×20×10` and `2–5 kg → 40×40×20`
are entered as:

| Up to weight (g) | Length | Breadth | Height |
|---|---|---|---|
| 2000 | 20 | 20 | 10 |
| 5000 | 40 | 40 | 20 |

Row 1 covers 0–2000 g, row 2 covers 2001–5000 g. Exactly 2000 g uses row 1; 2001 g moves to row 2.
A cart heavier than every row uses the largest row — add another (e.g. `10000 | 50 | 50 | 30`) if you
ship above your top bracket.

### B. Per-courier markup — on each Shipping Method's calculator

| Arg | Type | Meaning |
|---|---|---|
| **`courierName`** | string | Exact courier name from Shiprocket, e.g. `SRX Premium` (case-insensitive). |
| **`grams`** | int | Slab size for the markup, in grams. |
| **`gramsPerAmount`** | float | Rupees added per slab. `0` disables the markup. |
| **`staticCharge`** | float | Flat ₹ added to every quote. |

#### Setting the per-weight markup

The markup is **`ceil(cartWeightGrams ÷ grams) × gramsPerAmount`**, added on top of the courier rate.

**Example — "100 g = ₹1":** set `grams = 100`, `gramsPerAmount = 1`.

| Cart weight | `ceil(weight ÷ 100)` | Markup |
|---|---|---|
| 100 g | 1 | ₹1 |
| 250 g | 3 | ₹3 |
| 1000 g | 10 | ₹10 |
| 1500 g | 15 | ₹15 |

It **rounds up** to the next slab — 101 g charges 2 slabs (₹2). For exact linear pricing
(150 g = ₹1.50, no block rounding) use `grams = 1`, `gramsPerAmount = 0.01` (1 paisa/gram = ₹1 per 100 g).

## When a courier returns no rate

If the configured `courierName` isn't in Shiprocket's response for that destination/weight, or it
returns no price, the **shipping method is hidden**:

- **Checkout** (`eligibleShippingMethods`): the method is **not shown** to the customer.
- **`testShippingMethod`** query: `eligible: true` (it's a valid international order) but **`quote: null`**.
  The markup / static charge are **not** applied.

Other reasons a method won't show: destination is `IN`, no pickup pincode saved, or the cart's total
weight is 0 (variants missing the `weight` custom field).

---

# Part 2 — Fulfillment & tracking

Fulfilling an international order with the **Shiprocket International** fulfillment handler creates
the actual Shiprocket order, then lets you sync status and show live tracking.

```
Fulfil order (handler: "Shiprocket International")
   → build payload from order + config → POST international/orders/create/adhoc
   → store channel order id / SR order id / shipment id / status / box / weight on the Fulfillment
   → (later) assign courier + AWB in the Shiprocket panel
   → "Sync from Shiprocket" (orders/show)  → updates AWB / courier / status
   → live tracking (courier/track/awb)      → timeline in admin block + storefront
Cancel fulfillment → POST orders/cancel (SR order cancelled) → re-fulfil = new SR order
```

- **Order id** — every creation attempt sends a fresh **random 10-digit number** as Shiprocket's
  `channel_order_id`. It is stored on the fulfillment (`shiprocketChannelOrderId`) and shown in the
  order-detail block ("Order ID (sent to Shiprocket)"), so the Vendure ↔ Shiprocket link stays
  visible. If Shiprocket rejects the order, `createFulfillment` throws and Vendure rolls the
  fulfillment back — no dangling fulfillment.
- **Cancel & re-create** — cancelling the Vendure fulfillment automatically cancels the Shiprocket
  order (`orders/cancel`); a Shiprocket failure is logged but never blocks the Vendure cancellation.
  Re-fulfilling then creates a fresh Shiprocket order under a **new random order id** (Shiprocket
  keeps cancelled orders, so each creation needs a new `channel_order_id`).
- **Sync, not webhook** — v1 refreshes on demand via the **Sync from Shiprocket** button on the
  order-detail block. Tracking is fetched **live** (short-cached, 3 min) each time it's viewed, so
  the storefront shows a current timeline **without a webhook**. (A webhook would only be needed for
  ambient auto-updates — e.g. auto-transitioning the fulfillment to Delivered — which is out of v1.)

## Order-create payload — where each field comes from

| Payload field | Source |
|---|---|
| `order_id` | Random 10-digit number, new per attempt (stored as `shiprocketChannelOrderId`) |
| `order_date` | `order.orderPlacedAt` → `YYYY-MM-DD HH:mm` — SR shows it as **"Order created on channel"**; SR stamps **"Order created on system"** itself at the API call (= fulfillment moment) |
| `pickup_location` | Settings → **Pickup location name** (must match a Shiprocket panel nickname) |
| `billing_customer_name` / `_last_name` | `shippingAddress.fullName`, split first token / remainder |
| `billing_address` | **Door No + street combined**: `streetLine1, streetLine2` |
| `billing_address_2` | Always `""` (everything goes in line 1) |
| `billing_city` / `billing_pincode` | `city` / `postalCode` |
| `billing_state` | `shippingAddress.province` — the storefront's **State** input. **Required.** |
| `billing_country` | The country **name** (not code) from the address — i.e. whatever Settings → Countries names it. Name them properly: `United States`, `United Kingdom` (the name is snapshotted onto the order when the address is saved). |
| `billing_email` | Customer email |
| `billing_phone` | Local digits only — `sanitizePhone` strips a prepended country code |
| `billing_isd_code` | Derived from `countryCode` via `data/isd-codes.ts`: `US→+1`, `SG→+65`, `IN→+91`, … |
| `shipping_is_billing` | `true` |
| `order_items[]` | Line name/sku/qty; `selling_price` = `unitPriceWithTax ÷ 100`; `hsn` = product `hsnCode` custom field |
| `shipping_charges` | `order.shippingWithTax ÷ 100` |
| `sub_total` | Σ units × selling_price |
| `length` / `breadth` / `height` / `weight` | Box bracket matched to cart weight; weight in kg |
| `invoice_number` | **Vendure order code** (e.g. `JQAFHZH4PCYVDAR6`) — ties the SR invoice to the order |
| Fixed constants | `payment_method: "Prepaid"`, `purpose_of_shipment: 2`, `currency: "USD"`, `reasonOfExport: 3`, `commodity: "false"`, `mies: "false"`, `igstPaymentStatus: "B"`, `Terms_Of_Invoice: "CIF"`, `order_type: "ESSENTIALS"` |

## Validation — what blocks an order

**Pre-flight (this plugin, before any API call)** — fulfillment fails with a clear message when:
pickup location name is not configured; customer **phone** is empty; **postal code** is empty;
**state** is empty; the order has no items; or total **weight is 0**.

**Shiprocket-side (seen on the live API)** — the create call 422s when:

| Rule | Meaning |
|---|---|
| `billing_state` required | The State input must reach Vendure's `province` field — make it required in the storefront for international addresses |
| Address quality | Line 1 + line 2 combined must be **≥ 5 characters**, contain **≥ 1 number** and **≥ 1 space** — i.e. a real street address with a door/house number (`10 Anson Road` ✓, `Jjbhh` ✗) |

Shiprocket's generic `"Oops! Invalid Data."` hides the detail — this plugin logs the **full response
body** and surfaces the field-level errors in the thrown message, so the admin sees e.g.
`Oops! Invalid Data. — billing_state: The billing state field is required`.

## GraphQL surface

| API | Operation | Purpose |
|---|---|---|
| Admin | `mutation syncShiprocketFulfillment(fulfillmentId)` | Refresh a fulfillment from `orders/show` |
| Admin | `query shiprocketOrderFulfillments(orderId)` | Stored Shiprocket data per fulfillment (fields are `internal`) |
| Admin | `query shiprocketTracking(awb)` | Live tracking timeline |
| Shop  | `query shiprocketTracking(orderCode)` | Live tracking for the **authenticated owner's** order (token stays server-side) |

## Admin UI

- **Settings → Shiprocket International** — pickup pincode, pickup location name, FX rate, box table.
- **Order detail → "Shiprocket International" block** (shown for orders fulfilled via this handler) —
  Order ID sent to Shiprocket, SR order/shipment ids, status, courier, AWB, box & weight, last-synced
  time, a **Sync from Shiprocket** button, and an expandable live tracking timeline.

---

## Files

| File | Role |
|---|---|
| `../shiprocket.plugin.ts` | Single merged ShiprocketPlugin (Quick + International): registers services, checker, calculators, fulfillment handler, Fulfillment custom fields, settings field, admin/shop API, dashboard |
| `services/shiprocket.service.ts` | Serviceability call (cached), weight/HSN from order; `getToken()` delegates to the shared `ShipRocket` service (`../services/ship-rocket.ts`) so Quick + International reuse one cached login |
| `services/shiprocket-order.service.ts` | Order create / show / cancel / track IO (reuses the token; short-caches tracking) |
| `mappers/order-payload.mapper.ts` | Pure Order → `create/adhoc` payload + phone/ISD/validation (unit-tested in `order-payload.spec.ts`) |
| `data/isd-codes.ts` | ISO country → ISD dialing-code map |
| `config/pricing.ts` | Pure pricing math (unit-tested in `pricing.spec.ts`) |
| `config/shiprocket-eligibility-checker.ts` | International-destination gate |
| `config/shiprocket-calculator.ts` | Calculator args + price assembly |
| `config/shiprocket-fulfillment-handler.ts` | Creates the SR order on fulfillment, persists ids, cancels the SR order when the fulfillment is cancelled |
| `api/` | Admin (sync + fulfillment info + tracking) and shop (tracking) GraphQL |
| `dashboard/` | Settings page + order-detail Shiprocket block (ids, status, AWB, box, tracking, Sync) — registered by the plugin-wide dashboard entry `../dashboard/index.tsx` |

## Setup checklist

1. **Env vars** (`.env`): `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD`.
2. **Migration** — the fulfillment feature adds 14 custom-field columns to the `fulfillment` table.
   Generate and run a migration before using it (**never** `synchronize: true`; back up first —
   MySQL can't roll back DDL):
   ```bash
   npm run migration:generate -- shiprocket-fulfillment-fields
   # review the generated file, then
   npm run migration:run
   ```
3. **Settings → Countries** — name countries properly (`United States`, `United Kingdom`, …); the
   name is what `billing_country` sends. Existing orders keep the old name until their address is
   re-saved.
4. **Settings → Shiprocket International** — pickup pincode, pickup location name (must match a
   Shiprocket panel pickup nickname), FX rate, box table. Per channel.
5. **Product data** — every international-shippable variant needs `weight` (grams) > 0; every
   product a real `hsnCode` (placeholder codes pass the API but are wrong on customs paperwork).
6. **Storefront** — map the checkout's **State** input to `province` in `setOrderShippingAddress`
   and make it required for non-IN addresses; ideally also require a digit in the street address
   (mirrors Shiprocket's address rule).

---

## Tariff (import duty)

Shiprocket's `tariff` comes back keyed by HSN, e.g. `{"61091000": 15}`. Confirmed against the live API
to be the **import-duty rate (a percentage)** — identical across couriers, matching the HSN's duty
rate. It's a customs duty the recipient pays at destination, so the plugin records it in
`metadata.importTariff` for reference but does **not** add it to the shipping price.

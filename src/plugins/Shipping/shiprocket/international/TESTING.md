# Shiprocket International — Implementation & Testing Guide

International shipping rates via the Shiprocket serviceability API, exposed as Vendure shipping
methods. Each courier is its own shipping method; the customer is charged the courier's rate plus a
configurable per-gram slab markup, static charge and (optional) tariff, converted to the order
currency.

---

## 1. What was built

```
src/plugins/Shipping/shiprocket-international/
  ../shiprocket.plugin.ts     Merged ShiprocketPlugin (Quick + International): registers service + eligibility checker + calculator
                              + the `shiprocket.config` SettingsStore field + dashboard page
  constants.ts                API URLs, cache keys/TTLs, default config
  types.ts                    BoxBracket, ShiprocketConfig, typed API responses
  permissions.ts              ReadShiprocketSettings / UpdateShiprocketSettings
  services/shiprocket.service.ts
                              Auth-token caching (~9d), serviceability call (5m cache),
                              order weight + HSN extraction
  config/pricing.ts           Pure pricing math (base-rate pick, slab, tariff, FX)
  config/pricing.spec.ts      20 unit tests for the math
  config/shiprocket-eligibility-checker.ts   Cheap "is this an international order?" gate
  config/shiprocket-calculator.ts            The 5 args + the price formula
  config/shiprocket-fulfillment-handler.ts   Creates the Shiprocket order on fulfillment
  services/shiprocket-order.service.ts       Order create / show / track IO
  mappers/order-payload.mapper.ts (+ .spec)  Pure Order → create/adhoc payload (13 tests)
  data/isd-codes.ts                          ISO country → ISD dialing-code map
  api/                                        Admin (sync + info + tracking) & shop (tracking) GraphQL
  dashboard/index.tsx                        Settings nav item + order-detail Shiprocket block
  dashboard/shiprocket-settings-page.tsx     Box table + pincode + pickup-location + FX editor
  dashboard/order-shiprocket-block.tsx       Order-detail card: box, ids, status, AWB, tracking, Sync
  dashboard/queries.ts, order-shiprocket-queries.ts   GraphQL documents
```

Registered in `src/vendure-config-plugins.ts` under "Shipping & Fulfillment".

**Verification already done:**

| Check | Result |
|---|---|
| Server TypeScript (`tsconfig.json`) | 0 errors |
| Dashboard TypeScript (`tsconfig.dashboard.json`) | 0 errors in plugin code |
| Pricing unit tests | 20/20 pass |
| Dashboard production build (`vite build`) | Succeeds; settings page bundled |

---

## 2. Configuration model (two layers)

**Layer A — account/box settings** (per channel, edited on the Settings → Shiprocket International page):

| Field | Meaning |
|---|---|
| Pickup pincode | Origin pincode (`pickup_postcode`) |
| FX rate | INR per 1 USD. `1` = treat the courier rate as already in the order currency |
| Box dimensions table | Editable weight → L/B/H rows (cm) |

Hard-coded (not in the UI): `purpose_of_shipment = 2`, `currency = USD`. The destination country comes
from the order's shipping address, so there is **no allow-list**.

**Layer B — per-courier pricing** (calculator args, set on each shipping method):

| Arg | Type | Meaning |
|---|---|---|
| `courierName` | string | Exact Shiprocket courier name this method represents, e.g. `SRX Economy` (matched case-insensitively) |
| `grams` | int | Markup slab size in grams |
| `gramsPerAmount` | float | ₹ added per slab |
| `staticCharge` | float | Flat ₹ added to every quote |

Shiprocket's import tariff is recorded in `metadata.importTariff` for reference but is **not** charged
(it's a destination customs duty, not a courier fee).

---

## 3. Pricing formula

```
weightGrams = Σ(option measure in grams × qty)   // ProductOption measureValue + measureUnit (g/kg)
(L,B,H)     = smallest box-bracket row whose maxGrams ≥ weightGrams (else largest row)
resp        = Shiprocket serviceability(pickup, country, weightKg, L, B, H, hsnCodes)   // purpose=2, currency=USD
courier     = resp.available_courier_companies where courier_name == args.courierName (case-insensitive)
              → if not found, OR the courier returns no price, method is HIDDEN (no markup applied)

baseINR     = courier.rate.rate ?? courier.rate.total   (must be > 0)
              // rate.rate is the full freight incl. surcharges (e.g. Remote Area Surcharge);
              // rate.total is the fallback India Post couriers populate (there total == rate.rate)
slabMarkup  = ceil(weightGrams / grams) × gramsPerAmount
totalINR    = baseINR + slabMarkup + staticCharge
finalPrice  = round( (totalINR / fxRate) × 100 )      // order-currency minor units

// Import tariff (Σ courier.tariff) is recorded in metadata.importTariff but NOT charged.
```

**Worked example** — 1500 g cart, courier `SRX Economy` (base ₹816, no tariff returned), `grams=500`,
`gramsPerAmount=200`, `staticCharge=50`, `fxRate=1`:

```
slab   = ceil(1500/500) × 200 = 3 × 200 = ₹600
total  = 816 + 600 + 50 + 0   = ₹1466
final  = 1466 × 100           = 146600 paise  (₹1466.00)
```

---

## 4. Prerequisites before testing

> **⚠ Run the migration first (fulfillment only).** The fulfillment feature adds custom-field
> columns to the `fulfillment` table. Generate + run a migration before testing it — **never**
> `synchronize: true`, and back up first (MySQL can't roll back DDL):
> ```bash
> npm run migration:generate -- shiprocket-fulfillment-fields
> npm run migration:run
> ```
> Quoting/serviceability (§1–§8) needs no migration; only the fulfillment/tracking steps below do.

1. **Env vars** (already in `.env`): `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD` — a real Shiprocket
   account with international shipping enabled.
2. **Product data** the calculator depends on:
   - Each ordered **ProductVariant** must have an option with a Measure Value > 0 in g or kg (Catalog > Option Groups).
   - Each **Product** should have an `hsnCode` custom field (sent as `hsn_codes`).
3. A **non-IN shipping address** on the test order.
4. A **pickup location name** saved in Settings → Shiprocket International that matches a pickup
   address nickname in your Shiprocket panel (fulfillment only).
5. Server reachable on the Admin API (default `http://localhost:3000/admin-api`).

> The plugin adds two **custom permissions**. Test as **SuperAdmin** (which bypasses them), or grant
> `ReadShiprocketSettings` / `UpdateShiprocketSettings` to your role first.

---

## 5. Build & run

```bash
# install
bun install

# build everything (server TS + dashboard)
bun run build

# run server + worker + dashboard together
bun run dev
```

> Run only **one** `bun run dev` at a time. Duplicate dev servers fight over port 5173, and a stale
> one keeps serving an old bundle (so new dashboard pages/nav items don't appear). If a page is
> missing, kill every node/vite dev process and start a single `bun run dev`.

Run just the unit tests for the pricing math:

```bash
bunx vitest run --config vitest.unit.config.mts \
  src/plugins/Shipping/shiprocket-international/config/pricing.spec.ts
```

---

## 6. One-time setup in the admin

### 6a. Configure account + boxes
Dashboard → **Settings → Shiprocket International**:
- Pickup pincode: `625018` (your real origin)
- FX rate: `1` (treat the rate as already in the order currency) or e.g. `83` (INR → USD)
- Box dimensions table — add the rows you need, e.g.:

| Up to weight (g) | L | B | H |
|---|---|---|---|
| 2000 | 20 | 15 | 10 |
| 5000 | 30 | 25 | 15 |

Click **Save** (button enables only when there are unsaved changes).

### 6b. Create one shipping method per courier
Settings → **Shipping methods → New**, for each courier:
- **Eligibility checker:** `Shiprocket International (destination eligible)`
- **Calculator:** `Shiprocket International Rate` → fill `courierName`, `grams`,
  `gramsPerAmount`, `staticCharge`.

**Courier names from the sample response** (use the exact `courier_name`; yours may differ — check a
live serviceability response):

- `SRX Economy`
- `Aramex International`
- `India Post Air Parcel`
- `India Post EMS Merchandise`
- `India Post Tracked Packet Service`

---

## 7. Fast testing via GraphQL (no real checkout needed)

Vendure's built-in `testShippingMethod` runs your checker + calculator against a hypothetical order.
Run in the Admin API playground (`/admin-api`) as SuperAdmin.

```graphql
query {
  testShippingMethod(input: {
    checker:   { code: "shiprocket-international-eligibility", arguments: [] }
    calculator: {
      code: "shiprocket-international"
      arguments: [
        { name: "courierName",    value: "SRX Economy" }
        { name: "grams",          value: "500" }
        { name: "gramsPerAmount", value: "200" }
        { name: "staticCharge",   value: "50" }
      ]
    }
    shippingAddress: { streetLine1: "1 Test St", city: "Singapore", postalCode: "059897", countryCode: "SG" }
    lines: [{ productVariantId: "<A_VARIANT_ID_WITH_WEIGHT>", quantity: 1 }]
  }) {
    eligible
    quote { price priceWithTax metadata }
  }
}
```

- `eligible: true` + a `quote` ⇒ checker passed and the courier was serviceable.
- `metadata` contains `courierName`, `etd`, `estimatedDeliveryDays`, `eddFrom`/`eddTo` (delivery
  window in days, e.g. 10–12), `weightGrams`, `box`, and the price `breakdown` — use it to confirm the math.
- `eligible: false` or `quote: null` ⇒ see the test matrix below for why.

To see all serviceable couriers at once (real eligible methods on a built order, e.g. an active/draft
order), use `testEligibleShippingMethods(input: { shippingAddress, lines })` or the storefront
`eligibleShippingMethods` query.

---

## 8. Test matrix

| # | Scenario | Steps | Expected |
|---|---|---|---|
| T1 | Settings page loads | Open Settings → Shiprocket International | Form + box table render with defaults/saved values |
| T2 | Settings save | Edit pincode, add a box row, Save | Toast "saved"; reload keeps values (per channel) |
| T3 | Permission gate | Log in as a role **without** ReadShiprocketSettings | Nav item hidden / page shows Forbidden message |
| T4 | International eligible | `testShippingMethod` with `countryCode: "SG"`, valid courier | `eligible: true`, quote returned |
| T5 | Domestic hidden | Same but `countryCode: "IN"` | `eligible: false` (checker blocks IN) |
| T6 | No pincode configured | Clear pickup pincode, Save, re-test | `eligible: false` / no quote |
| T7 | Courier name match | `courierName: "srx economy"` (lower) vs the real `SRX Economy` | Both match (case-insensitive); quote returned |
| T8 | Courier not serviceable | Use a `courierName` not in the response | `quote: null` (method hidden) |
| T9 | Zero weight | Order a variant whose option has no g/kg Measure Value | `quote: null` (can't quote) |
| T10 | Slab markup math | 1500 g, grams=500, gramsPerAmount=200 | `breakdown.slabMarkupInr` = 600 |
| T11 | Base = rate.rate | Any serviceable courier | `breakdown.baseInr` = `rate.rate` (for India Post, `rate.rate == rate.total`) |
| T12 | Surcharge included in base | SRX courier whose `rate.rate` = Forward Charges + Remote Area Surcharge | `baseInr` = `rate.rate` (the full freight), **not** Forward Charges alone |
| T13 | Tariff not charged | Courier whose response has a `tariff` value | `metadata.importTariff` = Σ tariff, but price excludes it (base+markup+static only) |
| T14 | No price ⇒ hidden | Courier present in response but with rate 0/none | `quote: null`; markup NOT applied |
| T15 | FX conversion | Set FX rate 83 | `price` = round(totalINR/83 × 100) |
| T16 | Caching | Two methods (e.g. SRX Economy & Aramex), same cart | Only the first call hits Shiprocket (5-min cache); logs show one request |
| T17 | API failure is graceful | Temporarily set bad creds | Method hidden (no quote); server logs an error — checkout does not break |
| T18 | Storefront end-to-end | Real cart, set SG address, `eligibleShippingMethods` | Serviceable couriers appear with correct prices |

---

## 8b. Fulfillment & tracking (needs the migration)

Once an international order is paid, fulfil it with the **Shiprocket International** handler to create
the real Shiprocket order, then sync + track it.

### Create the Shiprocket order (fulfillment)
In the admin, fulfil the order and pick the **Shiprocket International** handler — or via GraphQL:

```graphql
mutation {
  addFulfillmentToOrder(input: {
    handler: { code: "shiprocket-international", arguments: [] }
    lines: [{ orderLineId: "<ORDER_LINE_ID>", quantity: 1 }]
  }) {
    ... on Fulfillment { id state method trackingCode }
    ... on ErrorResult { errorCode message }
    ... on CreateFulfillmentError { errorCode message fulfillmentHandlerError }
  }
}
```

- Success → a Fulfillment whose `method` is `Shiprocket International — <courier>` and whose custom
  fields hold `shiprocketOrderId` / `shipmentId` / box / weight.
- If the order is missing a phone, postal code, pickup-location name, items or weight, the handler
  throws a clear message and **no** fulfillment is created (pre-flight validation).

### Sync status / AWB (admin)
After you assign a courier + AWB in the Shiprocket panel, refresh Vendure:

```graphql
mutation { syncShiprocketFulfillment(fulfillmentId: "<FULFILLMENT_ID>") {
  success message status awb courierName invoiceUrl isIncomplete errors
} }
```

Or click **Sync from Shiprocket** on the order-detail "Shiprocket International" block.

### Tracking
```graphql
# Admin — by AWB
query { shiprocketTracking(awb: "<AWB>") { currentStatus etd trackUrl
  activities { date srStatusLabel location } } }

# Shop API — by order code (must be the authenticated owner; token stays server-side)
query { shiprocketTracking(orderCode: "<ORDER_CODE>") { currentStatus etd trackUrl
  activities { date srStatusLabel location } } }
```

### Fulfillment test matrix

| # | Scenario | Expected |
|---|---|---|
| F1 | Fulfil with the Shiprocket handler | Shiprocket order created; ids/box stored on the fulfillment |
| F2 | Order missing phone/pincode/state | Handler throws a clear message; no fulfillment, no Shiprocket order |
| F3 | Re-open the order detail | "Shiprocket International" block shows box, ids, status |
| F4 | Sync before AWB exists | `status` updates; `awb` still empty; block shows "AWB not generated yet" |
| F5 | Sync after AWB assigned | `awb` + `courierName` + invoice link populate |
| F6 | View tracking (admin/shop) | Timeline of activities; `trackUrl` present |
| F7 | Shop tracking as non-owner | Returns `null` (ownership enforced) |
| F8 | ISD code | Payload `billing_isd_code` = country code (`+65` SG, `+91` IN), not hardcoded |
| F9 | Cancel fulfillment | Vendure fulfillment → Cancelled; Shiprocket order cancelled too (status CANCELED); SR failure only logs a warning, never blocks |
| F10 | Re-fulfil after cancel | New Shiprocket order created with a **new random 10-digit** `channel_order_id`; shown on the block |

---

## 9. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Nav item missing | A stale/duplicate Vite dev server on :5173 (kill all node/vite, run one `bun run dev`); not SuperAdmin / `ReadShiprocketSettings` not granted; or dashboard not rebuilt |
| "Forbidden" on settings page | Grant `ReadShiprocketSettings`, or use SuperAdmin |
| Method never appears at checkout | Country is IN; pincode blank; option has no g/kg Measure Value; courier name mismatch; or courier not serviceable / returns no price |
| Quote is null but should exist | `courierName` doesn't match a `courier_name` in the live response (case-insensitive, but must otherwise be exact) — fetch a real serviceability response and copy the name |
| Auth errors in logs | `SHIPROCKET_EMAIL/PASSWORD` wrong, or account lacks international shipping |
| Price looks off by ×100 | Prices are minor units (paise/cents); ₹1466 = `146600` |
| Wrong converted price | Check the FX rate on the settings page (INR per 1 USD) |

---

## 10. Open item to confirm before go-live

The Shiprocket `tariff` field comes back keyed by HSN, e.g. `{"61091000": 15}`. Confirmed against the
live API to be the **import-duty rate (a percentage)** — identical across couriers. It is a customs
duty the recipient pays at destination, so it is recorded in `metadata.importTariff` for reference but
**not** added to the shipping price.

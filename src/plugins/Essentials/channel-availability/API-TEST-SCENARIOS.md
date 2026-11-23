 # Channel Availability — Shop API test scenarios

All queries hit the **shop-api**. The app that is "calling" is identified by the
`vendure-token` header (the channel the app booted on). Change the token → change
the host app.

## Setup

- Endpoint: `POST http://localhost/shop-api` (prod: `https://kaaikani.co.in/shop-api`)
- Headers:
  - `Content-Type: application/json`
  - `vendure-token: <channel token>`  ← selects host app + active channel

## Token → host app map (current DB)

| Channel token | Channel | Seller (brand) | Seller id |
|---|---|---|---|
| `ind-madurai` | Madurai | Kaaikani | 2 |
| `ind-salem` | Salem | Kaaikani | 2 |
| `ind-coimbatore` | Coimbatore | Kaaikani | 2 |
| `ind-trichy` | Trichy | Kaaikani | 2 |
| `ind-kochi` | Kochi | Kaaikani | 2 |
| `Ind-Snacks` | South Mithai | South-Mithai | 3 |
| `ind-Swadkerala` | SWAD KERALA | Swad Kerala | 4 |
| `sipnnnourish-coimbatore` | Sipn N Nourish Coimbatore | Sip N Nourish | 5 |
| `d7476xruz8xpzmkjsa6l` | __default_channel__ | Default Seller | 1 |

## Current seeded state

- **Allowlist**: host Kaaikani(2) → [2, 3, 4, 5]; host South-Mithai(3) → [3, 5].
  Hosts 1/4/5 have NO allowlist → they fall back to "all published brands".
- **Storefronts**: Kaaikani(2) = `OPENING_SOON` + published; South-Mithai(3) =
  `OPENING_SOON` + published; Swad(4)/Sip(5) = none (default `LAUNCHED`).
- ⚠️ **`OPENING_SOON` locks all of that brand's channels** (token null,
  isAvailable false, "Opening soon") no matter the pincode. To test real pincode
  availability for Kaaikani / South-Mithai, set their storefront `launchStatus`
  to `LAUNCHED` (SQL at the bottom).

## Real pincodes per channel (for the "available" cases)

| Channel | Seller | A pincode that IS available |
|---|---|---|
| Madurai | Kaaikani | `625001` |
| Salem | Kaaikani | `636001` |
| Coimbatore | Kaaikani | `631027` |
| Trichy | Kaaikani | `620014` |
| Kochi | Kaaikani | `682011` |
| South Mithai | South-Mithai | **any** (isAnywhere) |
| SWAD KERALA | Swad Kerala | **any** (isAnywhere) |
| Sipn N Nourish | Sip N Nourish | `641001` |

---

## A. `switcherBrands` — per-app brand list (grouped)

```graphql
query Switcher($postalCode: String) {
  switcherBrands(postalCode: $postalCode) {
    seller { id name }
    launchStatus
    bannerImage { id preview }
    channels {
      id code token name type isAvailable message launchStatus
    }
  }
}
```

### A1 — Kaaikani app (all brands)
Header `vendure-token: ind-madurai`, variables `{}`.
Expect **4 brand cards** in order: Kaaikani, South-Mithai, Swad Kerala, Sip N Nourish.
- Kaaikani + South-Mithai channels all `launchStatus: OPENING_SOON`, token null (locked).
- Swad + Sip channels `LAUNCHED`, resolve by pincode (none given → isAvailable false).

### A2 — South-Mithai app (curated subset)
Header `vendure-token: Ind-Snacks`, variables `{}`.
Expect **2 brand cards**: South-Mithai, Sip N Nourish. (No Kaaikani, no Swad.)

### A3 — Kaaikani app with a Madurai pincode
Header `vendure-token: ind-madurai`, variables `{ "postalCode": "625001" }`.
Same 4 cards. Madurai still locked while Kaaikani = OPENING_SOON; after you flip
Kaaikani to LAUNCHED, Madurai → `isAvailable: true`, token present.

### A4 — Host with no allowlist (fallback)
Header `vendure-token: ind-Swadkerala` (host = Swad Kerala, seller 4, no allowlist).
Falls back to **all published** brands (showInStoreSwitcher=true) = South-Mithai,
Kaaikani (sortOrder order). Demonstrates the "master app" fallback.

---

## B. `getAvailableChannels` with `sellerId` — drill into ONE brand (flat list)

```graphql
query BrandChannels($sellerId: ID!, $postalCode: String) {
  getAvailableChannels(sellerId: $sellerId, postalCode: $postalCode) {
    id code token name type isAvailable message launchStatus
  }
}
```

The `vendure-token` header can be any valid channel here (it does not filter the
result — `sellerId` does). Use `ind-madurai`.

### B1 — Kaaikani channels, no pincode
Variables `{ "sellerId": "2" }`.
Expect **5 channels**: Madurai, Salem, Coimbatore, Trichy, Kochi — Coimbatore
included even though its type is the `National` typo (seller filter bypasses the
type gate). All locked "Opening soon" while Kaaikani = OPENING_SOON.

### B2 — Kaaikani channels, Madurai pincode (after LAUNCHED)
Variables `{ "sellerId": "2", "postalCode": "625001" }`.
After flipping Kaaikani → LAUNCHED: Madurai `isAvailable: true` (token present);
the other 4 `isAvailable: false`, message "Available"/"Brand will available soon".

### B3 — South-Mithai channels
Variables `{ "sellerId": "3", "postalCode": "999999" }`.
South Mithai channel is `isAnywhere` → after LAUNCHED, `isAvailable: true` for ANY
pincode. While OPENING_SOON → locked.

### B4 — Swad Kerala channels (LAUNCHED by default)
Variables `{ "sellerId": "4", "postalCode": "999999" }`.
SWAD KERALA is `isAnywhere` and has no OPENING_SOON storefront → `isAvailable: true`.

### B5 — Sip N Nourish channels
Variables `{ "sellerId": "5", "postalCode": "641001" }` → `isAvailable: true`.
Variables `{ "sellerId": "5", "postalCode": "625001" }` → `isAvailable: false`.

---

## C. `getAvailableChannels` — global (no seller), original behaviour

```graphql
query AllChannels($postalCode: String) {
  getAvailableChannels(postalCode: $postalCode) {
    id code token name type isAvailable message launchStatus
  }
}
```

### C1 — no pincode, not logged in
Variables `{}`. All CITY/BRAND channels returned `isAvailable: false`, message
"Please set shipping address to see available brands". (DIRECT excluded.)
Note: Coimbatore is EXCLUDED here (type `National` ≠ CITY/BRAND) — the difference
from the seller-scoped path in B1.

### C2 — with a Kochi pincode
Variables `{ "postalCode": "682011" }` → Kochi channel `isAvailable: true`.

---

## D. `getAvailableChannels` — type filter

```graphql
query ByType($type: String, $postalCode: String) {
  getAvailableChannels(type: $type, postalCode: $postalCode) {
    id code name type
  }
}
```
- `{ "type": "CITY" }` → only CITY channels (Madurai, Salem, Trichy, Kochi — NOT
  Coimbatore, its type is `National`).
- `{ "type": "BRAND" }` → South Mithai, SWAD KERALA, Sipn N Nourish.
- `{ "type": "DIRECT" }` → kaaikanidirect coimbatore.

---

## E. curl template

```bash
curl -s http://localhost/shop-api \
  -H 'Content-Type: application/json' \
  -H 'vendure-token: ind-madurai' \
  -d '{"query":"query($p:String){ switcherBrands(postalCode:$p){ seller{id name} launchStatus channels{ code token isAvailable message } } }","variables":{"p":null}}' | jq
```

---

## Optional: unlock Kaaikani + South-Mithai for availability testing

`OPENING_SOON` locks everything. To see real pincode availability, set both to
`LAUNCHED`:

```sql
UPDATE brand_storefront SET launchStatus = 'LAUNCHED' WHERE sellerId IN (2, 3);
```

Then re-run A3 / B2 / B3. Revert with `... = 'OPENING_SOON'` when done.

---

## F. End-to-end flow (the real app journey)

Three calls: pick app → list brands → enter one brand.

```
STEP 1  App boots     →  header vendure-token = app's home channel token
STEP 2  Show brands   →  switcherBrands           (token = who is asking)
STEP 3  Tap a brand   →  getAvailableChannels(sellerId, postalCode, country)
STEP 4  Enter store   →  swap header vendure-token = the token returned in step 3
STEP 5  Confirm       →  activeChannel { code }
```

- Header token = WHO is asking (steps 1-2).
- `sellerId` = WHICH brand was tapped (step 3).
- Returned token = the store you ENTER (step 4).

### STEP 2 — brands for the Kaaikani app
Header `vendure-token: ind-madurai`
```graphql
query { switcherBrands { seller { id name } launchStatus channels { code token isAvailable } } }
```

### STEP 3 — tapped Kaaikani, pincode 625001, in India
Header `vendure-token: ind-madurai`
```graphql
query {
  getAvailableChannels(sellerId: 2, postalCode: "625001", country: "IN") {
    code token isAvailable message
  }
}
```
→ only Madurai, token `ind-madurai`.

### STEP 4 — enter that store
Set header `vendure-token: <token from step 3>`.

### STEP 5 — confirm
```graphql
query { activeChannel { id code } }
```

### Branch tests (same step 3, different taps)

| Tap | Args | Expect |
|---|---|---|
| South-Mithai, India | `sellerId:3, postalCode:"625001", country:"IN"` | National channel, token `Ind-Snacks` |
| South-Mithai, overseas | `sellerId:3, postalCode:"12345", country:"US"` | International channel — or "Service Not Available…" until ch16 = All Areas |
| Kaaikani, unserved pincode | `sellerId:2, postalCode:"999999", country:"IN"` | error "Service Not Available for the Given Pincode…" |
| Kaaikani, overseas | `sellerId:2, country:"US"` | error (Kaaikani ships India only) |

### curl (step 3)
```bash
curl -s http://localhost/shop-api -H 'Content-Type: application/json' -H 'vendure-token: ind-madurai' \
 -d '{"query":"query($s:ID,$p:String,$c:String){getAvailableChannels(sellerId:$s,postalCode:$p,country:$c){code token isAvailable message}}","variables":{"s":"2","p":"625001","c":"IN"}}' | jq
```


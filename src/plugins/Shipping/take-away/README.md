# Take Away (Store Pickup) Plugin

Adds store-pickup support:

- **`take-away-calculator`** — free (₹0) shipping calculator for the pickup method.
- **Pickup detection**: a shipping method counts as Take Away when its store is **pinned on the map** (`storeLatitude`/`storeLongitude` set) — no checkbox, no method-code convention.
- **`take_away_shipping_selected`** promotion condition — binding uses the promotion's own standard **Coupon code** field (no extra condition inputs): the promotion applies only when the selected pickup method's **Take Away Coupon Code** equals it. **A shipping method whose Take Away Coupon Code is empty gets no discount.** The plugin overrides `setOrderShippingMethod` to auto-apply the method's coupon on selection and auto-remove it on switch — the customer never types anything, so the discount behaves automatically.
- **Hidden from customers** — ANY promotion using this condition is excluded from the customer-facing `getCouponCodeList` query, whether or not it also has a coupon code (filter lives in `PromotionCodesPlugin`).
- **Store Location custom fields** on ShippingMethod (address, lat/lng, map link, coupon code) — public, so the storefront reads them from `eligibleShippingMethods`.
- **Order Notification Numbers** — comma-separated store phone numbers on the pickup method (edited in the same Store Location card). When a take-away order is placed, each number receives a **WhatsApp-only staff alert** (no SMS), sent by the `shipping-method-sms-template` plugin using the method's **Notification WhatsApp Template** field — separate from the customer's confirmation template. The staff template body must have **exactly two positional variables**: `{{1}}` = order code and `{{2}}` = order-placed date & time (IST, `DD-MM-YYYY hh:mm AM/PM`). WhatsApp rejects sends whose variable count or style (positional vs named) differs from the approved template. Both fields are **private** (never exposed through the Shop API), and the customer's own number is excluded so they never receive the staff alert.
- **Admin map picker** (both Angular admin and React dashboard) — the Store Location tab renders a map to pin the store. With `GOOGLE_MAPS_API_KEY` set in `.env` (Google Cloud: enable **Maps JavaScript API** + **Geocoding API**, key referer-restricted to the admin URLs), the map is interactive: click anywhere to pin, drag to adjust, pincode search via Google; every pin reverse-geocodes and shows the resolved address (display only — the admin fills Store Address manually). Without a key: embed preview only, pincode via OpenStreetMap Nominatim, plus GPS. The key is served at runtime via the `googleMapsApiKey` admin-API query, so changing it needs only a server restart, not a UI rebuild.
- **Order snapshot** — on order placed, the store location is copied to readonly Order custom fields (`isTakeAway`, `pickupAddress`, `pickupLatitude`, `pickupLongitude`, `pickupMapUrl`) so order history always shows the location as it was at purchase time, even if the store later moves.

## One-time Admin setup

1. **Migration** — the custom fields need a schema migration (see repo migration workflow; back up MySQL first).
2. **Shipping method** — Settings → Shipping methods → Create:
   - Any code/name you like (e.g. `take-away`)
   - Calculator: *Take Away (store pickup) — free*
   - Eligibility: *Default* (order minimum 0)
   - On the **Store Location** tab: **pin the store on the map** via click, pincode, or GPS (the pin is what marks the method as Take Away), and fill the Store Address
   - **Order Notification Numbers** (same card): comma-separated numbers (e.g. `9840012345, 9840067890`) that should be alerted on every new pickup order. Accepts `+91` / `91` / leading-0 formats.
   - **Notification WhatsApp Template** (same card): the approved MSG91 WhatsApp template for that staff alert (e.g. `new_order_alert`). Staff alerts are WhatsApp-only — without this template, the numbers are not messaged (a warning is logged).
   - For the **customer's** confirmation, fill the method's **Custom fields → General** tab (from the `shipping-method-sms-template` plugin): *Message Template ID* + *Data Type 1/2* for SMS, and/or tick *Send WhatsApp* + *WhatsApp Template Name*.
   - Assign to the relevant channels.
3. **Promotion** — Marketing → Promotions → Create:
   - Condition: *Take Away (store pickup) shipping method is selected*
   - Action: *Discount order by percentage* → 10
   - Set the promotion's **Coupon code** (e.g. `TAKEAWAY10`) and enter the same value in the shipping method's **Take Away Coupon Code** field. The coupon is auto-applied server-side the moment the customer selects that method and auto-removed when they switch away — nothing to type at checkout.
   - Assign to the same channels.

### Multiple take-away methods, each with its own promotion

1. Create each pickup method (e.g. `take-away-madurai`, `take-away-anna-nagar`), each with its store pinned, and give each a distinct **Take Away Coupon Code** value (e.g. `TAKEAWAY10`, `TAKEAWAY20`).
2. Create one promotion per method: coupon code = that method's value, plus the take-away condition.
3. Each promotion then applies automatically only while its own method is selected (the matching coupon is auto-applied/removed server-side) — the storefront does nothing.

## Storefront integration (Shop API)

**Checkout — offer pickup and pin the store:**

```graphql
query {
  eligibleShippingMethods {
    id
    code
    name
    priceWithTax
    customFields {
      takeAwayCouponCode
      storeAddress
      storeLatitude
      storeLongitude
      storeMapUrl
    }
  }
}
```

When the customer selects a method with `customFields.storeLatitude != null` (a pickup method), render the store pin from `storeLatitude`/`storeLongitude` (or link out via `storeMapUrl`) and call `setOrderShippingMethod` as usual. The discount applies automatically (it appears in `activeOrder.discounts`) and drops automatically when a different method is selected — no coupon mutations needed.

**Order history — show the pickup location with map:**

```graphql
query OrderHistory {
  activeCustomer {
    orders(options: { sort: { createdAt: DESC } }) {
      items {
        code
        state
        totalWithTax
        discounts { description amountWithTax }
        customFields {
          isTakeAway
          pickupAddress
          pickupLatitude
          pickupLongitude
          pickupMapUrl
        }
      }
    }
  }
}
```

If `isTakeAway` is true, render "Picked up at {pickupAddress}" and a map (embed with `pickupLatitude`/`pickupLongitude`, or link `pickupMapUrl`) instead of the shipping-address block.

## Pickup hours and pickup time

The admin sets the store's daily **pickup hours** on the method (`pickupSlot`, `from`/`to`); the customer picks a **pickup time** within them (`pickupTime` on the order, `h:mm AM` text). The same hours apply every day; there is no date.

**Admin setup** — the **Pickup Hours** editor sits inside the Store Location card (the Calculator card of the take-away method), under the notification fields: From and To, each as hour / minute / AM-PM dropdowns (quarter-hour minutes), plus Clear. It writes the method's `pickupSlot` custom field through the same bridge as the map pin; its own row on the Custom fields tab is hidden. Saving rejects half-set hours or hours that end before they start. A method with no hours asks the customer for no time, so existing methods are unaffected until hours are set.

**Customer** — the app offers the times from the start of the hours to the end in 15-minute steps (`pickupTimeOptions` in pickup-slot.ts is the reference) and saves the tap with the core `setOrderCustomFields` mutation. The field validator (`order-pickup-time.validator.ts`) rejects a time outside the selected pickup method's hours, or any time before a pickup method is selected; `takeAwayPickupTimeProcess` blocks the move to payment while the method has hours and the order has no valid time; switching to a method whose hours do not contain the time clears it (`take-away-shop.resolver.ts`). An admin editing the order page is held only to the time format, so staff can record a time agreed by phone.

**Order snapshot** — on order placed, `TakeAwayOrderSnapshotService` copies the hours onto the order's readonly `pickupSlot` with the rest of the pickup snapshot. The confirmation SMS/WhatsApp uses the chosen time (else the hours) as its second variable instead of the delivery estimate, and the admin order page's pickup card shows `<method name> · Pickup time 10:30 AM (store hours 10:00 AM - 12:00 PM)`.

**Shop API** — no new queries or mutations.

1. Checkout, with the store pin:

```graphql
query {
  eligibleShippingMethods {
    id
    code
    customFields {
      storeAddress
      storeLatitude
      storeLongitude
      pickupSlot { from to }
    }
  }
}
```

2. Select the pickup method as usual with `setOrderShippingMethod`, then save the customer's choice:

```graphql
mutation {
  setOrderCustomFields(input: { customFields: { pickupTime: "10:30 AM" } }) {
    ... on Order { id customFields { pickupTime } }
    ... on ErrorResult { errorCode message }
  }
}
```

   Rejected (as a GraphQL error) with `Select the Take Away shipping method before choosing a pickup time` or `Choose a pickup time within the store's pickup hours`.

3. Checkout. `transitionOrderToState(state: "ArrangingPayment")` returns an `OrderStateTransitionError` whose `transitionError` is `Please choose a pickup time for your Take Away order` while the method has hours and the order has no valid time.

4. Confirmation and order history: `customFields { pickupTime pickupSlot { from to } }` on the order, alongside `pickupAddress`.

**Unset hours read as `{ from: null, to: null }`**, not `null` (Vendure returns every struct as an object), so treat `from == null` as "no hours". Never send `pickupSlot: null` through the admin API: Vendure's struct validation dereferences the value and fails. The editor writes `{ from: null, to: null }` to clear, which is accepted. `pickupTime: null` is fine (plain string field). `updateShippingMethod` replaces the whole customFields object, so a script updating a method must send every custom field, as the admin form does.

Schema: `shipping_method.customFieldsPickupslot` (json), `order.customFieldsPickupslot` (json) and `order.customFieldsPickuptime` (varchar), via migrations `1791444784991-add-custom-fields.ts`, `1791449718000-take-away-pickup-slot-rename.ts` and `1791451225000-take-away-pickup-time.ts`.

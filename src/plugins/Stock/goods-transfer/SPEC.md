# Goods Transfer — Business Specification (SUPERSEDED)

> **SUPERSEDED by [PLAN.md](./PLAN.md). Do not add to this file and do not cite it in new code.**
>
> `PLAN.md` is the single authority: business rules (`GT-01`…`GT-16`), architecture decisions,
> build order and acceptance tests. New and rewritten code cites `GT-xx`, never `SPEC §`,
> and never the older `TDS §` / `BRS §` document, which no longer exists.
>
> This file stays only until the ~19 remaining `SPEC §` citations in the code have been
> rewritten to `GT-xx`. It is deleted in the final phase — deleting it now would leave
> those citations pointing at nothing, which is the exact failure it is here to prevent.

Status: superseded. Retained for reference while the citations are migrated.
Every rule below is a business decision, not an implementation detail.

---

## 1. Core

> A physical shipment is documented at the source branch, and becomes tracked
> stock when the destination branch receives it.

The source is a **dispatch point**, not an inventory-managed location. Source stock
is never read and never written by this module. The stock event happens **once**, at
the destination, on receive.

Everything else — the number, the PDF, the notifications, the audit trail, the damage
flow — is paperwork proving who sent what, when, and whether it arrived intact.

---

## 2. States

```
DRAFT ──► CONFIRMED ──► DISPATCHED ──► RECEIVED
```

Strictly forward. There is no revert. Correcting a transfer is an **edit in place**
(§4), not a move backwards.

| State | Meaning |
|---|---|
| `DRAFT` | Being built at the source. Nothing committed, destination cannot see it. |
| `CONFIRMED` | Lines locked in, document issued, destination notified. Goods have not left. |
| `DISPATCHED` | Goods physically left the source branch. |
| `RECEIVED` | Destination accepted. **Destination stock written. Terminal.** |

`RECEIVED` is terminal. Stock is already written, so changing it is a stock
correction — that is what the damage flow (§7) is for.

---

## 3. Who can do what

| Action | State(s) allowed | Who |
|---|---|---|
| Create | — | source |
| Edit lines / driver / remarks | `DRAFT`, `CONFIRMED`, `DISPATCHED` | source |
| Clear / delete the entry | `DRAFT` | source |
| Confirm | `DRAFT` → `CONFIRMED` | source |
| Dispatch | `CONFIRMED` → `DISPATCHED` | source |
| View (read-only) | `CONFIRMED` onward | destination |
| Receive | `DISPATCHED` → `RECEIVED` | destination |
| Raise damage | `RECEIVED` | destination |
| Approve / reject damage | damage `PENDING_APPROVAL` | source |

The destination can **never** edit a transfer. It views, receives, and raises damage.

### Access is role-based, never SuperAdmin-only

Every action above is gated by a **permission**, not by being SuperAdmin. Any admin
whose role carries the damage permissions can read and approve damage — SuperAdmin is
only the usual catch-all that satisfies every check, not a requirement.

### One admin, one branch

An admin belongs to **exactly one channel**. A Madurai admin cannot log into Kochi.

The destination is therefore **any branch except the one you are working in** — channel
membership is deliberately NOT the gate. Requiring the sender to be a member of the
receiving branch would hand them a login to it, which is the opposite of this rule.
Sending goods TO a branch and working IN a branch are different things.

Reading and acting on a transfer is still restricted: `assertChannelMember` and
`assertSourceChannel` keep each branch to its own documents. The default channel is
never a destination — it is Vendure's umbrella, not a physical branch.

### Product selection

The Ship-To destination decides which products can be entered. Madurai sells Tamil
products, Kochi sells Malayalam products — only products assigned to the **selected
destination channel**, and only **enabled** ones, are offered and accepted. Enforced
server-side, not just in the dropdown.

---

## 4. Editing after confirm

The source may edit at `DRAFT`, `CONFIRMED` and `DISPATCHED`. Real cases this exists for:

- Destination asks for extra items and the vehicle is still nearby → stop it, add items.
- An item was forgotten and the vehicle is long gone → remove that line.
- Destination wants extra but the vehicle is far → **do nothing**, it goes on the next transfer.

Rules:

1. **The transfer number never changes.** Issued once at create, kept for life —
   through every edit, and through re-confirm. A correction never burns a number.
2. **There is no version number.** Nobody needs to read "v2". The audit log already
   records every edit — who, when, and exactly what changed — and that is the history.
   A separate counter would add a number to maintain and explain, for no benefit.
3. **The PDF is replaced, not versioned.** Each re-confirm overwrites the same file:
   the old document is gone, only the current one exists. `pdfAssetId` stays stable so
   a saved link never breaks.
4. **The destination is notified with the diff** — what was added, what was removed,
   what changed quantity. The diff is stored in the audit log's `data` column, e.g.
   *"GT-MAD-0001 revised — 2 items added, 1 removed"*.
5. **No stock consequence.** Nothing is committed before receive, so an edit at any
   stage needs no compensating stock math.
6. After `RECEIVED`, editing is **blocked from every stage**.

---

## 5. Numbering and documents

One human identifier for the whole life of a transfer.

| | |
|---|---|
| `id` | internal database key, never shown to a human — **the only value passed between APIs** |
| `transferNumber` | the human identifier — document, lists, reports, search (e.g. `GT-MAD-0001`) |

There is **no dispatch number** and **no separate PDF number**. One transfer, one
lorry, one number.

### The transfer document (PDF)

**Required.** Every confirm produces an A4 PDF, printed and handed physically to the
driver. It is not optional and not deferred.

One transfer keeps **one document for its whole life**:

- The first confirm creates the asset.
- Every later edit + re-confirm **replaces it** — the same file is overwritten, so the
  old document is gone and only the current one exists. No accumulation, no orphaned
  assets, no storage growth per edit.
- `pdfAssetId` stays stable, so a link saved anywhere keeps working.

The document is titled by `transferNumber`. There is **no PDF version number and no
separate PDF numbering**.

`confirmGoodsTransfer` returns the transfer, so the printable document comes back in
the **same call** — no follow-up query before the driver can be handed the paper:

```graphql
mutation {
  confirmGoodsTransfer(id: 41) {
    transferNumber
    pdfAsset { source }    # direct URL — open and print
  }
}
```

`pdfAsset` (the core Vendure `Asset`, carrying the URL) is exposed alongside
`pdfAssetId`, because an id alone cannot be printed.

---

## 6. Stock

Written in exactly **one** place: destination, on receive.

| Event | Source stock | Destination stock |
|---|---|---|
| Create / edit / confirm / dispatch | untouched | untouched |
| **Receive** | untouched | **+ quantity** |
| Damage approved | untouched | **− damaged quantity** |

Negative stock is never allowed. A damage approval that would push the destination
below zero is blocked with a named error.

**Shared stock base (2026-10-12).** When the source and destination channels share a
StockLocation — Madurai, Coimbatore, Salem and Trichy all sell from the Madurai
location — the goods were already counted there before they left, so **Receive posts
nothing** and the transfer is pinned to that shared location (damage deducts from it).
Posting to the destination's own location counted the goods twice, and since pooled
availability is summed across every location it made stock sold out at Madurai look
available in every branch. Branches with no location in common keep the table above.
See `TransferChannelService.resolveSharedStockLocation`.

### Quantity units

- **PCS products** — integer pieces.
- **Weight products** — stored as **integer grams**, entered in **either kg or
  grams**, displayed as kg.

**Decision: both units are accepted on entry.** The catalogue runs from a 50 g
spice pouch to a 50 kg rice sack, and a single unit makes one end of that range
unpleasant to type — kg-only turns 50 g into `0.05`, grams-only turns 50 kg into
`50000`. Whichever the branch reads off the scale is what they may send.

| Field | Type | Rule |
|---|---|---|
| `weightKg` | `Float` | e.g. `1.5`, `0.05`. Stored as `Math.round(kg * 1000)`. |
| `weightGrams` | `Int` | Whole grams, passed straight through. |

Exactly **one** of the two per line — sending both is rejected. The damage flow
mirrors this exactly: `damagedKg` / `damagedGrams`, same converter, same rule.

Storage stays integer grams whichever unit was typed. Same principle Vendure
uses for money (paise stored, rupees shown): integers internally so repeated
add/deduct never drifts. `0.0004 kg` rounds to 0 g and is refused rather than
silently stored as nothing — the smallest recordable weight is `0.001 kg`.

Every weight is **read back in both units**: `weightGrams` is the stored value,
`weightKg` is derived on the way out and never stored, so the two can never
disagree. Screens display kg without doing the arithmetic themselves.

Exactly one of pieces or weight per line. Which one applies is decided by the
product's own stock flag — never by the caller.

---

## 7. Damage

Raised **after** receive, against a `RECEIVED` transfer.

```
DRAFT ──► PENDING_APPROVAL ──► APPROVED   (destination stock deducted)
                           └─► REJECTED   (no stock change)
```

`DRAFT` is **retained** — today requests are created already sent, but saving a damage
claim before submitting it is a likely future need, so the state stays.

1. Destination opens the transfer by its number — every product on it is listed.
2. They select the damaged products and enter the damaged quantity per product.
3. Damage percentage is calculated from the received quantity of that line and shown.
4. **A photo is mandatory when damage reaches 5%** of the line.
5. One request covers all damaged products of a transfer — not one request per product.
6. Source approves → destination stock is deducted. Source rejects → nothing changes.

Photos are stored as Vendure `Asset`s through the core `AssetService` — the same
mechanism the rest of the project uses.

**Known window:** between receive and damage approval, the destination's stock shows
the full quantity even though some is damaged. This is inherent to claiming damage
after receipt, and is accepted. `receivedQtySnapshot` on each damage line keeps the
audit correct.

---

## 8. Notifications

In-app only — the bell inside the admin panel. **This module sends no SMS, no
WhatsApp, no email. Nothing reaches a customer.**

| Event | Goes to |
|---|---|
| Transfer confirmed | destination |
| Transfer edited (after confirm) | destination, with the diff |
| Transfer dispatched | destination |
| Transfer received | source |
| Damage raised | source |
| Damage approved / rejected | destination |

The notification row in the database is the source of truth. If web push is added
later, it is a delivery channel layered on top — never a replacement.

---

## 9. Expiry — "Expire Soon"

The expiry clock starts when the **destination receives** the goods, which is why this
lives here and not in a separate module.

### Where the date comes from

Per transfer line, with a fallback:

```
if (line.expiryDate is set)
    expiry = line.expiryDate                     // source typed the real date
else if (variant.expiryDays is set)
    expiry = receivedAt + variant.expiryDays     // shelf life from product master
else
    no expiry tracking                           // line never appears on the page
```

Note the fallback needs `receivedAt`, so a computed expiry only exists **after
receive** — which is correct, because expiry is only tracked at the destination. An
explicitly typed `expiryDate` is visible from entry onwards.

This keeps fresh produce accurate (the source knows the real condition when loading)
without forcing a date on every line of every transfer.

### The page

**Expire Soon** lists received transfer lines **in the logged-in user's channel**,
expiring soonest first. Kochi sees only Kochi's. A line is flagged when its remaining
life is at or below the warning threshold (days remaining, one rule for both date
sources).

An `EXPIRY_SOON` notification is raised **once per line** to the destination channel —
never repeated.

### Indicator only

It never blocks stock, never blocks a sale, never changes a quantity. It tells a human
to go and physically check.

### Known limitation — accepted

Vendure pools stock; it has no batches. If Kochi holds 50 kg received on the 1st and
30 kg received on the 5th, the system sees **one 80 kg pool**, not two batches.

So the page can say *"a shipment of onions received on the 1st is nearing expiry — go
check"*. It **cannot** say *"23 kg of your 80 kg is old"*. Making that exact requires
full batch/lot tracking, which is a much larger module and deliberately out of scope.
As an indicator this is useful and cheap; as a system of record it would be wrong.

---

## 10. Clearing an entry

While building a transfer, many lines get entered and deleting them one at a time is
impractical. "Clear" wipes the whole entry.

- **Before save** — frontend only. Clear the form state.
- **After save** — deletes the draft.

Both show a confirmation first: *"Do you want to clear this entry?"* → Confirm / Cancel.

Clearing is only possible at `DRAFT`.

---

## 11. Out of scope

Removed or never to be added — each was scope creep that made the module harder to
reason about:

| Item | Reason |
|---|---|
| Batch / lot tracking | Would be needed for exact expiry per quantity. Far larger module — the Expire Soon indicator (§9) is the accepted substitute. |
| Source stock deduction, `sourceStockLocationId` | Source is a dispatch point, not inventory-managed. The field was never read. |
| `dispatchNumber` and its sequence | One transfer = one lorry. Carries no information the transfer number doesn't. |
| Separate PDF number sequences | Generated, stored, and then discarded — the PDF uses `transferNumber`. |
| Revert to draft | Replaced by edit-in-place. Removed — along with `RevertGoodsTransfer`. |
| Destination restricted to the sender's own channels | Forced cross-channel membership, which handed sending admins a login to the receiving branch. |
| Partial receipt | Not part of this process. Receive is all-or-nothing; shortfalls are damage. |
| Any customer-facing messaging | This module never contacts customers. |

---

## 12. Build order

Cleanup comes **last**, deliberately: details that look dead today may turn out to be
needed (as `DamageState.DRAFT` did). Nothing is deleted until the flow is proven.

| Step | What | Status |
|---|---|---|
| 1 | Spec freeze | done |
| 2 | Edit-at-any-stage — line diff, destination notification, PDF replace, `pdfAsset` | done |
| 2b | Destination rule, revert removal, API naming (see below) | done |
| 3 | Weight entered in kg **or grams** (§6) | done |
| 4 | Expiry — `expiryDate` per line, Expire Soon page | |
| 5 | Damage photos via `assetIds` | |
| 6 | GraphQL testing of the whole flow | |
| 7 | PWA screens | |
| 8 | Cleanup — remaining dead fields and sequences | |

**Pulled forward into step 2/2b, with reasons:**

- The *source* stock-location lookup in `confirm()`. It could only ever FAIL a confirm —
  the source is a dispatch point and may legitimately have no StockLocation — for a
  value nothing reads. Left in place it would have blocked testing of every later step.
- `revertGoodsTransfer` and its permission. Genuinely dead once edit-in-place works, and
  every time it appeared in the API it caused confusion about which path to use.
- The API names. Keeping `saveDraftGoodsTransfer` / `approveGoodsTransfer` while this
  document said `createGoodsTransfer` / `receiveGoodsTransfer` was a constant mismatch
  during testing. There is no UI yet, so renaming cost nothing.

**Still to remove at step 8:** `sourceStockLocationId`, `dispatchNumber`, `pdfNumber`
(all written and never read), and the unused `DocumentKind` sequences.

### Migration

`state` moving from `APPROVED` to `RECEIVED` is a data change — the column is a varchar,
so schema sync has nothing to alter, but existing rows would silently vanish from every
list. `src/migrations/…-goods-transfer-received-state.ts` updates `goods_transfer`,
`transfer_audit_log` and `transfer_notification`. `damage_request.state` keeps its own
`APPROVED` and is deliberately untouched.

Run it with `npm run migration:run`.

---

## 13. Open items

- **Web push notifications / PWA** — an idea for later, not part of this freeze. The
  notification table already supports it without rework.

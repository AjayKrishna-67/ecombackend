# Design: Brand Store Switcher — banner + launch status

**Date:** 2026-07-20
**Plugin:** `src/plugins/Essentials/channel-availability/`
**Mode:** office-hours (builder)
**Status:** APPROVED — Approach C (dedicated entity), ready to build

## Problem

The Kaaikani app "Switch Store" sheet lists brand channels (South Mithai, Swad
Kerala, Sip N Nourish, …). Admin needs to control, per brand and independent of
delivery area:
1. **Visibility** — which brands appear in the switcher.
2. **Launch state** — `OPENING_SOON` (visible, locked, no access) vs `LAUNCHED`
   (visible, tappable, token granted).
3. **Banner image** — the pre-designed marketing image, uploaded from admin.

Current `getAvailableChannels` gates on **postal code** only — a different axis
(delivery area), no image, no admin "show but lock" state. `enabled=false` hides
a channel entirely, so it cannot express "Opening Soon".

## Premises (agreed)

1. Launch status is a **new admin field**, orthogonal to postal availability. A
   brand can be `LAUNCHED` globally yet `isAvailable=false` for an out-of-zone
   address.
2. Banners are **pre-designed full images** (CTA text baked in) → one image per
   brand, no separate headline/CTA fields.
3. Visibility is a **new flag**, not `enabled`, because Opening-Soon brands stay
   visible.
4. **Storefront data lives in its own entity/table, not Channel customFields.**
   (User decision — keep Channel clean, own lifecycle.)

## Approach C (chosen): dedicated `BrandStorefront` entity

Vendure `Channel` is a core entity — no native columns without forking. Two ways
to attach per-channel data: customFields (rejected) or a **related entity**
(chosen). Build a new entity keyed to a channel.

### Entity: `BrandStorefront` (extends `VendureEntity`)

| Field | Type | Notes |
|-------|------|-------|
| `channel` | `OneToOne → Channel` (`@JoinColumn`, gives `channelId`) | One storefront row per channel. Unique on channelId. |
| `bannerImage` | `ManyToOne → Asset` (nullable) | References a Vendure Asset. Upload uses the existing asset pipeline; entity only stores the FK. |
| `launchStatus` | `string`/enum `OPENING_SOON` \| `LAUNCHED` | default `OPENING_SOON`. |
| `showInStoreSwitcher` | `boolean` | default `false`. Curation gate. |
| `sortOrder` | `int` (nullable) | Switcher ordering (screenshot has a deliberate order). |

`id/createdAt/updatedAt` come from `VendureEntity`. Not `ChannelAware` — the row
*describes* a channel, it isn't scoped content. `OneToOne` now; switch to
`ManyToOne` + `sortOrder` later if a brand ever needs multiple banners.

Register in plugin: `entities: [BrandStorefront]`.

### Admin API (new — this is the cost of "not customField")

`adminApiExtensions` on the plugin:
- Query `brandStorefronts` / `brandStorefront(channelId)`.
- Mutation `upsertBrandStorefront(channelId, bannerImageId, launchStatus,
  showInStoreSwitcher, sortOrder)`.
- Guard with `@Allow(Permission.UpdateChannel)` (or `UpdateSettings`).
- New admin service `BrandStorefrontService` (TransactionalConnection, RO-RO
  input). Banner **file** upload still goes through Vendure's standard
  `createAssets` mutation; this mutation just links the resulting `assetId`.

### Admin UI (new — decide location at build time)

Two options, pick one when building:
- **(i) Standalone Dashboard page** — a "Brand Storefronts" list: row per BRAND
  channel, asset upload/picker, launch toggle, show-in-switcher toggle, order.
  More reliable in the React Dashboard.
- **(ii) Channel-detail extension** — add a "Storefront" section to the existing
  channel page (matches where you were in the screenshot), if the Dashboard
  detail-extension API supports an asset picker cleanly.

Either way you build an **asset-picker component** yourself — the free picker was
the customField perk you're trading away. Wire in BOTH admin frontends per the
dual-frontend rule (Angular compile-admin-ui array + React Dashboard).

### Shop API (`api/api-extensions.ts`)

Add to `ChannelAvailability`:
```
launchStatus: ChannelLaunchStatus!   # enum OPENING_SOON | LAUNCHED
bannerImageUrl: String               # Asset.preview (nullable)
```
Keep `getAvailableChannels`. Switcher = BRAND view:
- Filter `type === 'BRAND'` AND storefront `showInStoreSwitcher === true`.
- `OPENING_SOON` → `isAvailable=false`, `token=null`, `message='Opening soon'`,
  still returned. Banner returned.
- `LAUNCHED` → existing postal-code logic decides `isAvailable`/`token`.
- Precedence: launchStatus is the outer gate; OPENING_SOON always locks. Banner
  shown even with no saved address (matches screenshot) — `getAllChannelsUnavailable`
  must also join the storefront row.

### Service changes (`channel-availability.service.ts`)

- Batch-load `BrandStorefront` rows for eligible channel ids in ONE query
  (`channelId IN (...)`, join `bannerImage`), map to channelId — mirror the
  existing postal-code batch pattern to avoid N+1.
- Add `launchStatus` + `bannerImageUrl` + storefront filter to both build paths.
- **Cache:** 15-min key is `postalCode:filter`; storefront edits won't invalidate
  it. Invalidate `invalidateAvailabilityCache()` from `BrandStorefrontService` on
  upsert, or accept ≤15-min staleness. Decide at build.

### Migration

One migration: `brand_storefront` table + FKs (channelId unique, bannerImageId).
Per project rule: **generate one, run it, before generating another.** Keep
`synchronize: false`.

## Distribution / rollout

Ships inside existing backend + Dashboard. App team needs the two new query
fields (`launchStatus`, `bannerImageUrl`). Coordinate the GraphQL contract before
merge.

## Alternatives (rejected)

- **A — Channel customFields (bannerImage relation→Asset + 2 fields):** Effort S,
  free Dashboard upload picker. Rejected: user wants storefront data in its own
  table, not on Channel.
- **B — URL string:** no uploader, admin hosts images externally.

## Build checklist

- [x] `BrandStorefront` entity + register in plugin
- [x] Generate + run migration (`brand_storefront` — 1784543072392)
- [x] Admin API: query (`brandStorefronts`, `brandStorefront`) + `upsertBrandStorefront` mutation + `BrandStorefrontService` (@Allow BrandStorefront perms)
- [x] Admin UI (React Dashboard): page `/brand-storefronts` (Settings nav), `AssetPickerDialog`. `dashboard/`.
- [x] Admin UI (Angular): `ui/` standalone component + routes + providers (nav under settings), `ModalService`+`AssetPickerDialogComponent`. Registered in `compile-admin-ui.ts`. Verify with `bun run build:admin`.
- [x] Shop schema: `launchStatus`, `bannerImage: Asset`, `ChannelLaunchStatus` enum
- [x] Service: batch-join storefront, launchStatus precedence, both build paths
- [x] Cache invalidation on storefront upsert (`invalidateTags` in `BrandStorefrontService.upsert`)
- [ ] Hand app team the updated query fields — **REMAINING**

## Iteration 2 (2026-07-20)

- **Seller gate:** a BRAND channel appears on the Brand Storefronts admin surfaces
  only when it has a Seller assigned other than "Default Seller". Filtered
  client-side in both React (`DEFAULT_SELLER_NAME`) and Angular lists. Shop query
  unchanged (still gated by `showInStoreSwitcher`).
- **Channel-detail block:** React Dashboard `pageBlocks` entry, `pageId:
  'channel-detail'`, after `custom-fields` → renders a per-channel storefront editor
  at the bottom of each BRAND channel's page (`shouldRender` = type BRAND).
  `channel-storefront-block.tsx`. Standalone `/brand-storefronts` page kept.
- **Angular channel-detail block:** NOT done (deferred) — needs
  `registerCustomDetailComponent({ locationId: 'channel-detail' })`.

### Open items
- **sortOrder not applied in shop output** — stored + editable, but
  `getAvailableChannels` does not `ORDER BY` it yet. Wire a sort before return.
- Default-seller detection is by name ('Default Seller'); switch to default-channel
  seller id if that name is ever changed.

## Behavior note (important)

`showInStoreSwitcher` defaults to **false**, so after deploy **every BRAND
disappears from the app switcher until an admin sets its storefront row**. This is
the intended curation gate, but it means the app goes empty until storefronts are
configured. Seed the launched brands' rows (or flip the default) as part of rollout.

## The Assignment

Before writing code: confirm the React Dashboard can host a **custom page with an
Asset upload/picker** in your version — that's the piece the dedicated-entity path
forces you to build, and it's the only real risk. If the Dashboard asset-picker
component is awkward to embed, the standalone-page option (i) or a thin Angular
admin page is the fallback. Verify that before committing to (ii).

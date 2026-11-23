# TODOS

## customer-analytics: route-level hard gate (React /dashboard ONLY)

- **What:** Block the React `/customer-analytics` route from rendering its page shell for
  roles lacking `ReadCustomerAnalytics`, not just hide the nav link.
- **Status:** Angular `/admin` UI: **DONE** — closed by the Angular port (2026-06-13), which
  adds a hand-rolled `canActivate` guard via `routeConfig` (admin-ui has no built-in
  permission route guard; `AuthGuard` is login-only). React `/dashboard`: **still open** (below).
- **Why:** `navMenuItem.requiresPermission` hides the link and the resolver `@Allow`
  gates the data, but a user without the permission who deep-links the URL still gets
  the empty page shell (queries fail silently). Cosmetic, no data leak.
- **Pros:** Cleaner UX — unauthorized deep-link redirects instead of showing an empty shell.
- **Cons:** `@vendure/dashboard` has no native route-permission API; needs a hand-rolled
  guard/redirect in the route `loader`. Adds custom framework-adjacent code.
- **Context:** Surfaced during /plan-eng-review of the editable-thresholds + roles work
  (2026-06-12); re-scoped to React-only during /plan-eng-review of the Angular port
  (2026-06-13). The data is already safe via `@Allow(ReadCustomerAnalytics, SuperAdmin)`
  on the resolver; this is polish only. Start point: the route `loader` in
  `src/plugins/Marketing/customer-analytics/dashboard/index.tsx`.
- **Depends on / blocked by:** Ships after the nav-gating change lands (same file).

## product-tags: rename + merge governance tooling

- **What:** Admin tooling to rename a tag and merge two tags into one (repoint join rows, delete loser), in both Angular `/admin` and React `/dashboard`.
- **Why:** Tag display value is first-writer-wins (`findOrCreate` dedupes on normalized `key`). Autocomplete curbs near-dupes but doesn't eliminate them; over time `fresh`/`Fresh ` style drift accumulates with no cleanup path.
- **Pros:** Keeps the tag vocabulary clean long-term; merge fixes accidental dupes.
- **Cons:** A management screen in two frontends + a merge resolver (repoint ProductTag/ProductVariantTag rows transactionally).
- **Context:** Deferred from product-tags v1 per eng review 2026-06-25 (T3). v1 ships create+assign+filter+deleteTag. Outside-voice flagged the governance gap. Start point: add `mergeTags(keepId, loserId)` + `renameTag(id,value)` to the Tags plugin resolver.
- **Depends on / blocked by:** product-tags v1 (Tag + join entities + resolver) shipped.

## product-tags: storefront (Shop API) tag filtering

- **What:** Expose tag-based product filtering on the Shop API for shopper-facing browse / automated-collection-style pages.
- **Why:** The full Shopify tag vision (automated collections, faceted browse) is the eventual end-state; v1 is deliberately admin-only.
- **Pros:** Unlocks shopper browse-by-tag and tag-driven collections without a data-model change.
- **Cons:** New Shop resolver + likely DefaultSearchPlugin index work so tags are searchable, not just filterable.
- **Context:** Deferred from product-tags v1 (admin-only scope). The ChannelAware Tag + join entities already support reverse traversal, so this is additive. Start point: add a Shop API `productsByTag` resolver mirroring the admin one (channel-scoped).
- **Depends on / blocked by:** product-tags v1 entities/service shipped.

## repo hygiene: CLAUDE.md stack facts are stale

- **What:** Update `CLAUDE.md` — it says "Vendure 3.1.0" and "Admin UI: Angular 17.3.12" and never mentions the React Dashboard.
- **Why:** Actual stack is Vendure 3.6.3 + Angular 19.2, and BOTH `AdminUiPlugin` (`/admin`) and `DashboardPlugin` (`/dashboard`) run side by side (`vendure-config-plugins.ts:159` + `:170`). The stale Angular-only framing nearly routed the product-tags UI to the wrong frontend during this review.
- **Pros:** Stops the next feature from repeating the wrong-UI / wrong-version assumption.
- **Cons:** None of consequence; small doc edit.
- **Context:** Surfaced by the outside-voice pass during product-tags eng review 2026-06-25. Update version line, Angular version, and add a note that the project runs two admin frontends.
- **Depends on / blocked by:** —

## product-import: Angular /admin dialog parity (export + upsert + permission)

- **What:** Bring the export + CSV-upsert + per-button permission gating to the Angular `/admin` import dialog (`src/plugins/Essentials/product-import/ui/import-products-dialog.component.ts`), matching the React `/dashboard` version.
- **Why:** Both admin frontends run live; `/admin` users (SuperAdmins working there) won't get export/update until this lands.
- **Pros:** Feature parity across both frontends; backend resolvers are already shared so this is UI-only.
- **Cons:** Second CSV-helper copy to keep in sync (ui-devkit copies only the ui/ folder; dashboard composite tsconfig blocks cross-boundary import).
- **Context:** Deferred during the 2026-06-30 eng review (scope = React /dashboard only). Reuse the same backend `exportProducts` / `createProductsFromCsv` / `updateProductsFromCsv` resolvers.
- **Depends on / blocked by:** the product-import backend resolvers (this PR).

## product-import: v2 bulk-edit options / assets / facets via update CSV

- **What:** Extend `updateProductsFromCsv` to mutate optionGroups/optionValues, assets/variantAssets, facets/variantFacets (immutable in v1, currently ignored on update).
- **Why:** Full catalog round-trip editing in one file instead of the product UI.
- **Pros:** Power-user bulk editing of the whole product shape.
- **Cons:** Options/assets are Vendure's hardest mutation area (cardinality, ordering, channel assignment); high regression risk. Only worth it with real demand.
- **Context:** Flagged high-risk during the 2026-06-30 eng review; v1 deliberately keeps update at the variant grain (price/stock/tax/customFields).
- **Depends on / blocked by:** v1 update path shipped + observed demand.

## payments: PR-2 price lock at Pay + quote-honoring repair (after PR-1 security)

**Status 2026-10-22: BUILT** (uncommitted, in the same working tree as PR-1, at the user's request). Tests: `razorpay-price-lock.e2e-spec.ts` (16), `decide-price-lock-repair.spec.ts`, `addon-price-calculation.strategy.spec.ts`. Remaining: staging check with real Razorpay test keys.

- **What:** Freeze repricing to AddingItems orders (price-update plugin + AddonPriceCalculationStrategy for core paths), reprice once at Pay, strict settle-time repair (honor the Razorpay quote for no-revert underpays captured within 60 min, no cap, tax-less PRICE-LOCK-ADJ), overpay/duplicate-capture alerts with history entries, admin popup channel fix. (The guest-safe ownership check moved to PR-1 by CEO review D5.)
- **Why:** A price change after the customer taps Pay strands paid orders in ArrangingPayment (price up) or silently overcharges (price down).
- **Pros:** No more stuck paid orders from price drift; staff stop fixing them by hand.
- **Cons:** About 12 files on the payment/pricing path; needs the stubbed-Razorpay e2e harness.
- **Context:** All decisions are in `docs/designs/price-lock-at-pay.md` (eng review D12-D22). Deferred from one bundled PR by CEO review D2 (2026-10-21) so the security fix ships alone first. Start at `price-update.plugin.ts:246` and `razorpay-settlement.service.ts:94`.
- **Depends on / blocked by:** PR-1 (Razorpay security) merged.

## price-update: PR-3 release 2 cleanup (after PR-2)

- **What:** Compare the channel price with `listPrice` (not net `unitPrice`), make `updatePricesForActiveOrder` rethrow so the drain's backoff/failed works, move `PriceUpdateService` to `services/price-update.service.ts`, route `Order.lines` through it and delete the duplicate `updatePricesInline`, the dead `onRead` interceptor, `PriceUpdateShopResolver`, `api/api-extensions.ts` and the feeder-less old queues.
- **Why:** The x1.05 loop wrote 3,246 fake history entries on 344 lines since Aug 1 (local snapshot); drain failures are marked done; the duplicate path drifts.
- **Pros:** Less DB churn, one pricing path, a smaller plugin.
- **Cons:** Touches the hot shop read path; the moved service makes a large diff.
- **Context:** Eng review D23/D26/D27 in `docs/designs/price-lock-at-pay.md`. Deferred by CEO review D3 (2026-10-21). The channel-filtered sweep was dropped (D27).
- **Depends on / blocked by:** PR-2 merged (both touch price-update.plugin.ts).

## config: PR-4 synchronize:false (P0)

- **What:** Run a read-only TypeORM schema diff against the DB and confirm only known generate noise, then set `synchronize: false` in `src/vendure-config.ts:346`.
- **Why:** The committed value is `true` under its own "NEVER true" comment (`:343`). TypeORM DDL at boot already dropped variant columns once (2026-10-08).
- **Pros:** Stops surprise schema changes on deploy.
- **Cons:** Drift is no longer auto-applied; all schema changes must go through migrations.
- **Context:** Eng review D25. Deferred to its own PR by CEO review D4 (2026-10-21) so it rolls back independently. Can ship before PR-2/PR-3.
- **Depends on / blocked by:** nothing; independent.

## payments: settle Authorized Razorpay payments once Razorpay captures them (after PR-1)

- **What:** When Razorpay captures a payment that Vendure holds as `Authorized`, settle it (webhook + reconciliation), and make the handler's `settlePayment` confirm the capture at Razorpay before returning success.
- **Why:** The webhook skips any payment it already has, whatever its state (`razorpay-webhook.service.ts:369-375`), and `settleFromRazorpay` returns `'already'` for `PaymentAuthorized` (`razorpay-settlement.service.ts:97`), so an Authorized payment never becomes Settled on its own. `settlePayment` returns `{ success: true }` without asking Razorpay (`razorpay.handler.ts:79-81`), so an admin can mark an expired, never-captured authorization as paid.
- **Pros:** Vendure's payment state always matches Razorpay; no manual settle clicks; no unchecked admin settles.
- **Cons:** Changes the webhook dedupe rule and the settlement `'already'` early return; `settlePayment` gains a Razorpay API call.
- **Context:** Found by the CEO review outside voice (OV-2) on 2026-10-21 and tracked by D9. PR-1 (D6) already sends app payments that Razorpay has captured straight to Settled, so what remains is payments caught between authorize and auto-capture. This business treats `PaymentAuthorized` as a placed order (`delivery-partner.service.ts:342`). Effort: human S / CC S. Priority: P2.
- **Depends on / blocked by:** PR-1 (Razorpay security) merged.

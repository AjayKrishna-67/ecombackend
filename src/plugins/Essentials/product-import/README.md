# Product Import Plugin

Adds an **Import Products** button to the product list in both the new **React Dashboard** and the classic **Angular Admin UI**. Clicking it opens a dialog to download a CSV template, select a CSV file, preview a summary, and bulk-import products.

The import itself uses Vendure core's built-in `importProducts(csvFile: Upload!): ImportInfo` mutation — this plugin only contributes UI. No custom backend, entities, or resolvers.

---

## Features

- **Action bar button** on the Products list, placed next to *Rebuild search index*.
- **Download template** — generates a standard Vendure product-import CSV with the correct columns and two example rows.
- **File summary preview** — shows file name, size, and number of data rows before importing.
- **Import result** — shows `imported / processed` counts and a list of any row errors.
- **Permission gated** — visible only to **SuperAdmin** (matches the permission required by the core `importProducts` mutation).

---

## Where it appears

| UI | Location | How it renders |
|----|----------|----------------|
| React Dashboard (`@vendure/dashboard`) | `/dashboard` → Catalog → Products | Action bar item, placed **before** the `rebuild-index-button` |
| Angular Admin UI (`@vendure/admin-ui`) | `/admin` → Catalog → Products | Action bar item on `locationId: 'product-list'`, opens a modal |

---

## CSV format

The file must be a comma-separated CSV. The first row is the header. Column order is not significant, but the header names must match exactly.

### Required columns (Vendure core)

```
name,slug,description,assets,facets,optionGroups,optionValues,sku,price,taxCategory,variantAssets,variantFacets
```

### Optional columns

| Column | Notes |
|--------|-------|
| `stockOnHand` | Integer stock per variant. |
| `trackInventory` | `true` / `false`. |

### Custom field columns (this project)

Custom fields use a `product:` or `variant:` prefix followed by the field name:

| Column | Entity | Type | Description |
|--------|--------|------|-------------|
| `product:hsnCode` | Product | string | HSN code (tax classification). |
| `variant:shadowPrice` | ProductVariant | int | Shadow price. |

Weight and unit are not variant columns: they come from the option's Measure Value + Measure Unit (Catalog > Option Groups).

### Full template header

```
name,slug,description,assets,facets,optionGroups,optionValues,sku,price,taxCategory,stockOnHand,trackInventory,variantAssets,variantFacets,product:hsnCode,variant:shadowPrice
```

### Example rows

```csv
Example T-Shirt,example-t-shirt,A comfortable cotton t-shirt,,category:Apparel,size,Small,TSHIRT-S,19.99,standard,100,true,,,1234,2499
,,,,,,Medium,TSHIRT-M,19.99,standard,80,true,,,,2499
```

**Multi-variant products:** the first row carries the product-level fields (`name`, `slug`, `description`, `product:hsnCode`, etc.). Each following row with an **empty `name`** adds another variant to the same product — fill only the variant columns (`optionValues`, `sku`, `price`, `variant:shadowPrice`, …).

### Column reference

- `facets` — format `facetName:facetValueName` (e.g. `category:Apparel`). Separate multiple with `|`.
- `optionGroups` / `optionValues` — leave both empty for a single-variant product.
- `taxCategory` — must match an **existing tax category name** in the target channel, otherwise those rows fail.
- `assets` / `variantAssets` — file paths/URLs to import; leave empty if none.

---

## How to use

1. Open the **Products** list (Dashboard or Angular Admin).
2. Click **Import Products** (top right, next to *Rebuild search index*).
3. Click **Download template** to get a correctly-formatted starter CSV.
4. Fill in your product rows, save as CSV.
5. Click the file picker, select your CSV. The dialog shows name, size, and data-row count.
6. Click **Import**.
7. Review the result: `imported / processed`. Any per-row errors are listed.

---

## Installation / build

The plugin is registered in [`src/vendure-config-plugins.ts`](../../../vendure-config-plugins.ts) as `ProductImportPlugin`.

### React Dashboard

Registered via the `dashboard: './dashboard/index.tsx'` property on the plugin. Rebuild the dashboard bundle:

```bash
bun run build:dashboard
```

Served by `DashboardPlugin` at the `/dashboard` route.

### Angular Admin UI

Registered via the static `ProductImportPlugin.UiExtensions` and wired into [`src/compile-admin-ui.ts`](../../../compile-admin-ui.ts). The runtime serves a pre-compiled admin (`customAdminUi({ recompile: false })`), so the extension only appears **after** rebuilding the admin app:

```bash
bun run build:admin
```

> ⚠️ `build:admin` runs `rimraf admin-ui` and regenerates the whole admin app (the `admin-ui/` folder is build output, not hand-written source), then runs a full Angular AOT build (several minutes). Run it when the admin can be briefly rebuilt.

---

## File structure

```
src/plugins/Essentials/product-import/
├── product-import.plugin.ts            # VendurePlugin: dashboard + UiExtensions
├── dashboard/                          # React Dashboard extension
│   ├── index.tsx                       # defineDashboardExtension → actionBarItems
│   ├── import-products-dialog.tsx      # React dialog (upload, summary, template, result)
│   └── queries.ts                      # importProducts mutation document
└── ui/                                 # Angular Admin UI extension
    ├── providers.ts                    # addActionBarItem → ModalService.fromComponent
    └── import-products-dialog.component.ts   # Standalone Angular Dialog component
```

---

## Technical notes

- **File upload:** both UIs send the CSV using the GraphQL multipart request spec.
  - React Dashboard: `api.mutate(importProductsDocument, { csvFile })` — the dashboard's `awesome-graphql-client` auto-detects the `File` and builds the multipart request.
  - Angular Admin: `dataService.mutate(IMPORT_PRODUCTS, { csvFile })` — the admin Apollo client uses `apollo-upload-client`.
- **`Upload` scalar:** in the Dashboard's gql.tada config the `Upload` scalar maps to `unknown`, so passing a `File` typechecks without a cast.
- **Permissions:** the core `importProducts` resolver is `@Allow(Permission.SuperAdmin)`. The buttons are gated to SuperAdmin to match.
- **Row count** in the preview is a naive non-empty-line count (header excluded). Authoritative validation happens server-side during import.

---

## Limitations

- Preview is a file summary only — it does not validate column contents before upload.
- `taxCategory` and `facets` values must already exist in the target channel.
- Large files are processed synchronously by the core importer; very large catalogs may take time.

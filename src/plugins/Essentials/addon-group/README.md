# Addon Group Plugin

A Vendure plugin that adds **add-on item** support to product variants. Addon groups work like facets — they are created independently, then assigned to product variants using a facet-style search-and-assign UI. Customers see available add-ons when viewing a product and can select them during checkout.

## Table of Contents

- [Architecture](#architecture)
- [Database Schema](#database-schema)
- [Plugin Structure](#plugin-structure)
- [How It Works](#how-it-works)
  - [Admin Workflow](#admin-workflow)
  - [Storefront Workflow](#storefront-workflow)
- [GraphQL API Reference](#graphql-api-reference)
  - [Admin API](#admin-api)
  - [Shop API](#shop-api)
- [Custom Fields](#custom-fields)
- [Permissions](#permissions)
- [Validation Rules](#validation-rules)
- [Admin UI](#admin-ui)
- [Examples](#examples)

---

## Architecture

```
┌──────────────────┐                     ┌─────────────────┐
│   AddonGroup     │──── OneToMany ──────│   AddonItem     │
│   (standalone)   │                     │                 │
│                  │                     │ - name          │
│ - name           │                     │ - price         │
│ - description    │                     │ - sku           │
│ - selectionType  │                     │ - isDefault     │
│   (CHECKBOX|     │                     │ - minQuantity   │
│    QUANTITY)     │                     │ - maxQuantity   │
│ - isRequired     │                     │ - sortOrder     │
│ - minSelections  │                     │ - enabled       │
│ - maxSelections  │                     │ - image (Asset) │
│ - sortOrder      │                     └─────────────────┘
│ - enabled        │
│ - channels[]     │
└────────┬─────────┘
         │
         │  ManyToMany (via custom field relation)
         │
┌────────┴─────────┐
│ ProductVariant    │
│                   │
│ customFields:     │
│   addonGroups[]   │  ◄── Assigned via facet-style search UI
└───────────────────┘      (under "Addon Groups" tab)

         │
         │  At checkout (addAddonsToOrderLine mutation)
         │
┌────────┴─────────┐
│   OrderLine      │
│                   │
│ customFields:     │
│   addonSelections │  ◄── JSON snapshot of all selected addons with quantities
└───────────────────┘

│   OrderLine.addonSelections (GraphQL field resolver)
│   ◄── Parsed JSON array of AddonGroupSelection objects
```

**Selection Types:**
- **CHECKBOX** — Customer toggles items on/off (quantity always 1)
- **QUANTITY** — Customer picks items with a quantity (min/max per item)

---

## Database Schema

### `addon_group` table

| Column         | Type                       | Default   | Description                              |
|----------------|----------------------------|-----------|------------------------------------------|
| id             | int (auto)                 | -         | Primary key (from VendureEntity)         |
| createdAt      | datetime                   | now       | Creation timestamp                       |
| updatedAt      | datetime                   | now       | Last update timestamp                    |
| name           | varchar                    | -         | Display name (e.g., "Gift Options")      |
| description    | text (nullable)            | null      | Optional description                     |
| selectionType  | enum(CHECKBOX, QUANTITY)   | CHECKBOX  | Toggle or quantity-based selection        |
| isRequired     | boolean                    | false     | Must the customer select an addon?       |
| minSelections  | int                        | 0         | Minimum items the customer must pick     |
| maxSelections  | int                        | 1         | Maximum items the customer can pick      |
| sortOrder      | int                        | 0         | Display ordering                         |
| enabled        | boolean                    | true      | Active/inactive toggle                   |

### `addon_item` table

| Column      | Type              | Default | Description                                |
|-------------|-------------------|---------|--------------------------------------------|
| id          | int (auto)        | -       | Primary key                                |
| createdAt   | datetime          | now     | Creation timestamp                         |
| updatedAt   | datetime          | now     | Last update timestamp                      |
| name        | varchar           | -       | Display name (e.g., "Gift Wrap")           |
| price       | int               | 0       | Price in **minor units** (e.g., 500 = $5)  |
| sku         | varchar (nullable)| null    | Optional SKU for inventory tracking        |
| isDefault   | boolean           | false   | Pre-selected in the storefront             |
| minQuantity | int               | 0       | Min quantity per item (QUANTITY groups)     |
| maxQuantity | int               | 1       | Max quantity of this item per order line    |
| sortOrder   | int               | 0       | Display ordering within the group          |
| enabled     | boolean           | true    | Active/inactive toggle                     |
| groupId     | int (FK)          | -       | Foreign key to addon_group (CASCADE delete)|
| imageId     | int (FK, nullable)| null    | Foreign key to asset (SET NULL on delete)  |

---

## How It Works

### Admin Workflow

1. **Create Addon Groups**: Admin UI > Catalog > Addon Groups > "Add Addon Group"
   - Set type to CHECKBOX (toggle on/off) or QUANTITY (with min/max count)
   - Configure min/max selections and required flag

2. **Add Items**: On the group detail page, add items with name, price, SKU, min/max quantity, and optional image from Assets

3. **Assign to Variants**: On the product variant detail page, use the "Addon Groups" tab to search and assign groups

### Storefront Workflow

1. **Query addons**: `addonGroupsForVariant(productVariantId)` returns enabled groups with items, images, and quantity constraints

2. **Add to cart**: Call `addItemToOrder` to add the main product, then `addAddonsToOrderLine` to attach addon selections with quantities

3. **View in order**: Query `OrderLine.addonSelections` for a parsed list of all addon choices (group name, item name, quantity, price, image)

---

## GraphQL API Reference

### Admin API

```graphql
# Queries
addonGroup(id: ID!): AddonGroup
addonGroups(options: AddonGroupListOptions): AddonGroupList!

# Mutations
createAddonGroup(input: CreateAddonGroupInput!): AddonGroup!
updateAddonGroup(input: UpdateAddonGroupInput!): AddonGroup!
deleteAddonGroup(id: ID!): DeletionResponse!
createAddonItem(input: CreateAddonItemInput!): AddonItem!   # includes imageId, minQuantity
updateAddonItem(input: UpdateAddonItemInput!): AddonItem!   # includes imageId, minQuantity
deleteAddonItem(id: ID!): DeletionResponse!
```

### Shop API

```graphql
# Queries
addonGroupsForVariant(productVariantId: ID!): [AddonGroup!]!

# Mutations
addAddonsToOrderLine(input: AddAddonsToOrderLineInput!): Order!

# Extended types
extend type OrderLine {
    addonSelections: [AddonGroupSelection!]!   # parsed from JSON custom field
}
```

#### Adding Addons to Cart

```graphql
# Step 1: Add main product
mutation {
  addItemToOrder(productVariantId: "42", quantity: 1) {
    ... on Order {
      lines { id productVariant { name } }
    }
  }
}

# Step 2: Attach addon selections to the order line
mutation {
  addAddonsToOrderLine(input: {
    orderLineId: "line-1"
    selections: [
      {
        addonGroupId: "1"
        items: [
          { addonItemId: "10", quantity: 2 }   # QUANTITY type: 2x Extra Cheese
          { addonItemId: "11", quantity: 1 }   # 1x Olives
        ]
      },
      {
        addonGroupId: "2"
        items: [
          { addonItemId: "20", quantity: 1 }   # CHECKBOX type: Gift Wrap
        ]
      }
    ]
  }) {
    id
    lines {
      id
      addonSelections {
        groupId
        groupName
        selectionType
        items {
          itemId
          itemName
          quantity
          unitPrice
          imageUrl
        }
      }
    }
    surcharges { description listPrice }
  }
}
```

---

## Custom Fields

### ProductVariant.customFields.addonGroups

| Property    | Value                                           |
|-------------|-------------------------------------------------|
| Type        | `relation` (ManyToMany -> AddonGroup)           |
| List        | `true` (multiple groups per variant)            |
| Public      | `true` (accessible via Shop API)                |
| Eager       | `false` (loaded on demand)                      |
| UI Tab      | "Addon Groups" (on variant detail page)         |
| UI Component| Facet-style search & assign                     |

### OrderLine.customFields.addonSelections

| Property    | Value                                           |
|-------------|-------------------------------------------------|
| Type        | `text` (JSON string)                            |
| Nullable    | `true`                                          |
| Public      | `true`                                          |
| Purpose     | Stores JSON snapshot of addon selections        |
| UI Tab      | "Addons"                                        |

The JSON structure stored:
```json
[
  {
    "groupId": "1",
    "groupName": "Toppings",
    "selectionType": "QUANTITY",
    "items": [
      { "itemId": "10", "itemName": "Extra Cheese", "quantity": 2, "unitPrice": 5000, "imageUrl": "/assets/cheese.jpg" },
      { "itemId": "11", "itemName": "Olives", "quantity": 1, "unitPrice": 3000, "imageUrl": null }
    ]
  }
]
```

An `OrderLine.addonSelections` field resolver automatically parses the JSON for GraphQL queries.

---

## Permissions

| Permission         | Description                        |
|--------------------|------------------------------------|
| CreateAddonGroup   | Create addon groups and items      |
| ReadAddonGroup     | View addon groups and items        |
| UpdateAddonGroup   | Edit addon groups and items        |
| DeleteAddonGroup   | Delete addon groups and items      |

---

## Validation Rules

### Addon Group
- `maxSelections` must be at least 1
- `minSelections` must be at least 0
- `minSelections` cannot exceed `maxSelections`
- Required groups must have `minSelections >= 1`

### Addon Item
- `price` must not be negative
- `minQuantity` must be at least 0
- `maxQuantity` must be at least 1

### Cart (addAddonsToOrderLine)
- Group must be assigned to the product variant
- Group and items must be enabled
- CHECKBOX items must have quantity = 1
- QUANTITY items must have quantity within minQuantity..maxQuantity
- Number of selected items must be within minSelections..maxSelections
- Required groups must have at least minSelections items

# Cart Validation Plugin

**Version**: 1.0.0  
**Compatibility**: Vendure ^3.1.0

## Overview

The Cart Validation Plugin automatically validates shopping carts to ensure customers can only checkout with available products. When products or variants are disabled by administrators, they are automatically flagged in the cart response, and checkout is blocked until unavailable items are removed.

## Features

- ✅ **Automatic Validation**: Runs every time `activeOrder` is accessed
- ✅ **Real-time Detection**: Identifies disabled products/variants instantly
- ✅ **Checkout Blocking**: Prevents orders with unavailable items
- ✅ **Clear Error Messages**: Provides detailed unavailable item information
- ✅ **Performance Optimized**: Bulk queries + request-level caching (<500ms for 50 items)
- ✅ **Zero Breaking Changes**: Extends existing GraphQL schema

## How It Works

### 1. Validation Triggers

The plugin validates cart contents when:
- Customer views their cart (`activeOrder` query)
- Customer attempts checkout (state transition to `ArrangingPayment`)
- Any cart modification occurs

### 2. Validation Logic

```
For each order line:
  IF product.enabled = false OR variant.enabled = false
    → Mark as unavailable
    → Include in validation error list
```

### 3. Architecture

- **CartValidationService**: Core validation logic with caching
- **Entity Resolvers**: Add `validationStatus`, `isAvailable`, `unavailableReason` fields
- **Order Interceptor**: Blocks state transitions when validation fails

## GraphQL API

### New Fields on Order

```graphql
type Order {
  # ... existing fields
  
  validationStatus: CartValidationStatus!
}

type CartValidationStatus {
  isValid: Boolean!
  hasUnavailableItems: Boolean!
  totalUnavailableItems: Int!
  unavailableItems: [UnavailableCartItem!]!
}
```

### New Fields on OrderLine

```graphql
type OrderLine {
  # ... existing fields
  
  isAvailable: Boolean!
  unavailableReason: String
}
```

### Error Type

```graphql
type CartContainsUnavailableItemsError implements ErrorResult {
  errorCode: ErrorCode!
  message: String!
  unavailableItems: [UnavailableCartItem!]!
}
```

## Usage Example

### Query Cart with Validation

```graphql
query {
  activeOrder {
    code
    validationStatus {
      isValid
      hasUnavailableItems
      totalUnavailableItems
      unavailableItems {
        orderLineId
        productName
        variantName
        reason
      }
    }
    lines {
      id
      productVariant {
        name
      }
      isAvailable
      unavailableReason
    }
  }
}
```

### Handle Checkout Validation

```graphql
mutation {
  transitionOrderToState(state: "ArrangingPayment") {
    __typename
    ... on Order {
      id
      state
    }
    ... on CartContainsUnavailableItemsError {
      errorCode
      message
      unavailableItems {
        orderLineId
        productName
        reason
      }
    }
  }
}
```

## Client-Side Integration

### React Example

```typescript
const { data } = useQuery(GET_ACTIVE_ORDER);
const { validationStatus, lines } = data?.activeOrder || {};

// Show warning if cart has unavailable items
{validationStatus?.hasUnavailableItems && (
  <Alert severity="warning">
    {validationStatus.totalUnavailableItems} items are no longer available
  </Alert>
)}

// Disable checkout button
<button disabled={!validationStatus?.isValid}>
  Checkout
</button>
```

## Performance

- **10-item cart**: <100ms
- **50-item cart**: <500ms
- **Caching**: Request-level WeakMap cache prevents duplicate queries
- **Bulk Loading**: Single database query for all variants

## Integration with Price-Update Plugin

This plugin works seamlessly alongside the price-update plugin:
- Both use EntityResolver pattern (no conflicts)
- Independent execution (can be enabled/disabled separately)
- Price updates run first, then validation runs
- Both fields merged in single GraphQL response

## Configuration

No additional configuration required. The plugin is automatically registered and configured in `vendure-config.ts`:

```typescript
import { CartValidationPlugin } from './plugins/cart-validation/cart-validation.plugin';

export const config: VendureConfig = {
  plugins: [
    // ... other plugins
    PriceUpdatePlugin,
    CartValidationPlugin,  // Add after PriceUpdatePlugin
  ],
};
```

## Testing

### Manual Test Scenarios

1. **Valid Cart** - All products enabled → `isValid: true`
2. **Disabled Product** - Disable product → `isAvailable: false`
3. **Disabled Variant** - Disable variant → `isAvailable: false`
4. **Checkout Block** - Try checkout with disabled product → Error returned
5. **Remove & Retry** - Remove disabled product → Checkout succeeds

### GraphQL Test Query

```graphql
query TestValidation {
  activeOrder {
    validationStatus {
      isValid
      unavailableItems {
        productName
        reason
      }
    }
  }
}
```

## Troubleshooting

### Validation doesn't run
**Solution**: Ensure you're querying `validationStatus` or `isAvailable` fields. Validation only runs when these fields are requested.

### Checkout still proceeds
**Solution**: Verify `CartValidationPlugin` is registered after `PriceUpdatePlugin` in the plugins array.

### Performance issues
**Solution**: Check database indexes on `product.enabled` and `product_variant.enabled` fields.

## Technical Details

### Files Structure

```
src/plugins/cart-validation/
├── cart-validation.plugin.ts          # Main plugin & service
├── api/
│   ├── api-extensions.ts              # GraphQL schema
│   └── cart-validation-entity.resolver.ts  # Field resolvers
├── config/
│   └── cart-validation.interceptor.ts # State transition guard
└── types/
    └── validation-types.ts            # TypeScript interfaces
```

### Database Queries

The plugin uses efficient bulk queries:

```sql
SELECT 
  variant.id, variant.enabled,
  product.id, product.enabled
FROM product_variant variant
JOIN product ON variant.productId = product.id
WHERE variant.id IN (?, ?, ?, ...)
```

## License

Same as Vendure project

## Support

For detailed integration examples, see:
- `specs/001-disabled-product-validation/quickstart.md`
- `specs/001-disabled-product-validation/contracts/shop-api.graphql`

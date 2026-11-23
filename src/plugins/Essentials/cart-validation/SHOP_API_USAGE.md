# Shop API Usage - Cart Validation

## Overview

The Cart Validation Plugin exposes a Shop API query that allows your frontend to check if the cart is valid before attempting checkout. This provides real-time feedback to customers about invalid items.

---

## GraphQL Query

### `validateActiveOrder`

Validates the current customer's active order/cart and returns detailed information about any invalid items.

**Query:**
```graphql
query ValidateCart {
  validateActiveOrder {
    isValid
    totalInvalidItems
    errorMessage
    invalidItems {
      orderLineId
      productName
      variantId
      variantSku
      reason
      validationType
    }
  }
}
```

**Response Example (Valid Cart):**
```json
{
  "data": {
    "validateActiveOrder": {
      "isValid": true,
      "totalInvalidItems": 0,
      "errorMessage": null,
      "invalidItems": []
    }
  }
}
```

**Response Example (Invalid Cart):**
```json
{
  "data": {
    "validateActiveOrder": {
      "isValid": false,
      "totalInvalidItems": 2,
      "errorMessage": "Cannot proceed to checkout. Please remove or update the following items:\n1. Product \"Wireless Mouse\" is no longer available\n2. Product \"USB Cable\" has insufficient stock. Available: 5, Requested: 10",
      "invalidItems": [
        {
          "orderLineId": "123",
          "productName": "Wireless Mouse",
          "variantId": "985",
          "variantSku": "WM-001",
          "reason": "Product \"Wireless Mouse\" is no longer available",
          "validationType": "VARIANT_DISABLED"
        },
        {
          "orderLineId": "124",
          "productName": "USB Cable",
          "variantId": "986",
          "variantSku": "USB-002",
          "reason": "Product \"USB Cable\" has insufficient stock. Available: 5, Requested: 10",
          "validationType": "INSUFFICIENT_STOCK"
        }
      ]
    }
  }
}
```

---

## Validation Types

The `validationType` field indicates why an item is invalid:

| Type | Description |
|------|-------------|
| `PRODUCT_DISABLED` | The product has been disabled by admin |
| `VARIANT_DISABLED` | The product variant has been disabled by admin |
| `INSUFFICIENT_STOCK` | Not enough stock available for the requested quantity |
| `PRODUCT_DELETED` | The product has been deleted |

---

## Frontend Integration Examples

### React/TypeScript Example

```typescript
import { gql, useQuery } from '@apollo/client';

const VALIDATE_CART_QUERY = gql`
  query ValidateCart {
    validateActiveOrder {
      isValid
      totalInvalidItems
      errorMessage
      invalidItems {
        orderLineId
        productName
        variantSku
        reason
        validationType
      }
    }
  }
`;

function CartValidation() {
  const { data, loading, error } = useQuery(VALIDATE_CART_QUERY);

  if (loading) return <div>Validating cart...</div>;
  if (error) return <div>Error validating cart</div>;

  const validation = data?.validateActiveOrder;

  if (!validation?.isValid) {
    return (
      <div className="cart-validation-error">
        <h3>⚠️ Some items in your cart are unavailable</h3>
        <ul>
          {validation.invalidItems.map((item) => (
            <li key={item.orderLineId}>
              <strong>{item.productName}</strong> ({item.variantSku})
              <br />
              <span className="error-reason">{item.reason}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return <div className="cart-valid">✓ Your cart is ready for checkout</div>;
}
```

### Vue.js Example

```vue
<template>
  <div>
    <div v-if="!validation.isValid" class="cart-validation-error">
      <h3>⚠️ Some items in your cart are unavailable</h3>
      <ul>
        <li v-for="item in validation.invalidItems" :key="item.orderLineId">
          <strong>{{ item.productName }}</strong> ({{ item.variantSku }})
          <br />
          <span class="error-reason">{{ item.reason }}</span>
        </li>
      </ul>
    </div>
    
    <button 
      :disabled="!validation.isValid"
      @click="proceedToCheckout"
    >
      Proceed to Checkout
    </button>
  </div>
</template>

<script>
import gql from 'graphql-tag';

export default {
  data() {
    return {
      validation: {
        isValid: true,
        invalidItems: []
      }
    };
  },
  apollo: {
    validation: {
      query: gql`
        query ValidateCart {
          validateActiveOrder {
            isValid
            totalInvalidItems
            invalidItems {
              orderLineId
              productName
              variantSku
              reason
              validationType
            }
          }
        }
      `,
      update: data => data.validateActiveOrder
    }
  }
};
</script>
```

### Angular Example

```typescript
import { Component, OnInit } from '@angular/core';
import { Apollo, gql } from 'apollo-angular';

const VALIDATE_CART_QUERY = gql`
  query ValidateCart {
    validateActiveOrder {
      isValid
      totalInvalidItems
      errorMessage
      invalidItems {
        orderLineId
        productName
        variantSku
        reason
        validationType
      }
    }
  }
`;

@Component({
  selector: 'app-cart-validation',
  template: `
    <div *ngIf="validation && !validation.isValid" class="alert alert-warning">
      <h4>⚠️ Cart Validation Issues</h4>
      <p>{{ validation.errorMessage }}</p>
      <ul>
        <li *ngFor="let item of validation.invalidItems">
          <strong>{{ item.productName }}</strong> ({{ item.variantSku }})
          <br />
          {{ item.reason }}
        </li>
      </ul>
    </div>
    
    <button 
      [disabled]="!validation?.isValid"
      (click)="proceedToCheckout()"
    >
      Proceed to Checkout
    </button>
  `
})
export class CartValidationComponent implements OnInit {
  validation: any;

  constructor(private apollo: Apollo) {}

  ngOnInit() {
    this.apollo.query({ query: VALIDATE_CART_QUERY })
      .subscribe(({ data }: any) => {
        this.validation = data.validateActiveOrder;
      });
  }

  proceedToCheckout() {
    if (this.validation?.isValid) {
      // Proceed to checkout
    }
  }
}
```

---

## When to Call This Query

### 1. **Cart Page Load**
Validate cart when user visits cart page:
```typescript
useEffect(() => {
  if (isCartPage) {
    refetch(); // Refetch validation
  }
}, [isCartPage]);
```

### 2. **Before Checkout Button**
Check validity before enabling checkout:
```typescript
<CheckoutButton 
  disabled={!cartValidation?.isValid}
  onClick={handleCheckout}
/>
```

### 3. **After Cart Updates**
Re-validate after adding/removing items:
```typescript
const handleAddToCart = async (variantId: string) => {
  await addToCart(variantId);
  await refetchCartValidation(); // Re-check validity
};
```

### 4. **Periodic Checks (Optional)**
Check cart validity every few minutes:
```typescript
useInterval(() => {
  refetchCartValidation();
}, 120000); // Every 2 minutes
```

---

## UI/UX Recommendations

### Display Invalid Items
```jsx
{invalidItems.map(item => (
  <CartItem 
    key={item.orderLineId}
    item={item}
    hasError={true}
    errorMessage={item.reason}
    // Allow removing invalid items
    onRemove={() => removeFromCart(item.orderLineId)}
  />
))}
```

### Disable Checkout Button
```jsx
<button 
  disabled={!validation.isValid || loading}
  className={!validation.isValid ? 'disabled' : ''}
>
  {validation.isValid 
    ? 'Proceed to Checkout' 
    : `Cannot Checkout (${validation.totalInvalidItems} invalid items)`
  }
</button>
```

### Show Error Banner
```jsx
{!validation.isValid && (
  <Alert variant="warning">
    <AlertIcon />
    <AlertTitle>Some items are unavailable</AlertTitle>
    <AlertDescription>
      Please remove invalid items to proceed with checkout
    </AlertDescription>
  </Alert>
)}
```

### Highlight Invalid Items
```css
.cart-item.invalid {
  border: 2px solid #f44336;
  background-color: #ffebee;
  opacity: 0.7;
}

.cart-item.invalid .product-name {
  text-decoration: line-through;
}
```

---

## Error Handling

### Handle Network Errors
```typescript
const { data, loading, error } = useQuery(VALIDATE_CART_QUERY, {
  onError: (error) => {
    console.error('Cart validation failed:', error);
    // Show user-friendly message
    toast.error('Unable to validate cart. Please refresh the page.');
  }
});
```

### Handle No Active Order
If there's no active order (empty cart), the query returns:
```json
{
  "isValid": true,
  "invalidItems": [],
  "totalInvalidItems": 0
}
```

---

## Performance Considerations

### 1. **Caching**
Configure Apollo cache to avoid excessive queries:
```typescript
const client = new ApolloClient({
  cache: new InMemoryCache({
    typePolicies: {
      Query: {
        fields: {
          validateActiveOrder: {
            // Cache for 30 seconds
            merge: true,
          },
        },
      },
    },
  }),
});
```

### 2. **Conditional Fetching**
Only fetch when cart has items:
```typescript
const { data } = useQuery(VALIDATE_CART_QUERY, {
  skip: cartItemCount === 0, // Don't fetch if cart is empty
});
```

### 3. **Debounce Updates**
Debounce validation after rapid cart changes:
```typescript
const debouncedValidate = debounce(() => {
  refetch();
}, 500);
```

---

## Testing

### Test Query in GraphQL Playground

1. Navigate to: `http://localhost:3000/shop-api`
2. Login as a customer
3. Add items to cart
4. Run the query:

```graphql
query {
  validateActiveOrder {
    isValid
    totalInvalidItems
    errorMessage
    invalidItems {
      orderLineId
      productName
      variantSku
      reason
      validationType
    }
  }
}
```

### Test Scenarios

1. **Valid Cart**: Add available products → Should return `isValid: true`
2. **Disabled Product**: Add product, admin disables it → Should show in `invalidItems`
3. **Out of Stock**: Add 10 items, admin reduces stock to 5 → Should show insufficient stock
4. **Empty Cart**: No items in cart → Should return `isValid: true, invalidItems: []`

---

## TypeScript Types

```typescript
export enum ValidationFailureType {
  PRODUCT_DISABLED = 'PRODUCT_DISABLED',
  VARIANT_DISABLED = 'VARIANT_DISABLED',
  INSUFFICIENT_STOCK = 'INSUFFICIENT_STOCK',
  PRODUCT_DELETED = 'PRODUCT_DELETED',
}

export interface InvalidCartItem {
  orderLineId: string;
  productName: string;
  variantId: string;
  variantSku: string;
  reason: string;
  validationType: ValidationFailureType;
}

export interface CartValidationResult {
  isValid: boolean;
  totalInvalidItems: number;
  errorMessage?: string;
  invalidItems: InvalidCartItem[];
}
```

---

## Support

If you encounter issues:
1. Check browser console for GraphQL errors
2. Verify user is authenticated
3. Check server logs for validation messages
4. Ensure plugin is registered in `vendure-config.ts`

For advanced use cases, refer to the main `README.md` in the plugin directory.


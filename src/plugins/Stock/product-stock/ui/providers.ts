import { registerCustomDetailComponent, registerFormInputComponent } from '@vendure/admin-ui/core';
import { ProductStockComponent } from './product-stock.component';
import { ProductStockToggleSuppressedComponent } from './product-stock-toggle-suppressed.component';

export default [
  registerCustomDetailComponent({
    locationId: 'product-detail',
    component: ProductStockComponent,
  }),
  // Suppress the default inline checkbox for the `productStockEnabled` custom
  // field; the real toggle lives in the ProductStockComponent block above.
  registerFormInputComponent('product-stock-toggle-suppressed', ProductStockToggleSuppressedComponent),
];

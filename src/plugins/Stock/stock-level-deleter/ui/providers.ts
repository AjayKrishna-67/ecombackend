import { registerCustomDetailComponent } from '@vendure/admin-ui/core';
import { StockRemoverComponent } from './stock-remover.component';

export default [
  registerCustomDetailComponent({
    locationId: 'product-variant-detail',
    component: StockRemoverComponent,
  }),
];


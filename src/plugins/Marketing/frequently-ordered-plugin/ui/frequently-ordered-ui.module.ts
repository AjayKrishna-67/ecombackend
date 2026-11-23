import { NgModule } from '@angular/core';
import { SharedModule, registerDashboardWidget } from '@vendure/admin-ui/core';
import { ProductSalesGraphComponent } from './product-sales-graph.component';

@NgModule({
  imports: [SharedModule],
  declarations: [ProductSalesGraphComponent],
  providers: [
    registerDashboardWidget('product-sales-graph', {
      title: 'Product Sales Graph',
      loadComponent: () => Promise.resolve(ProductSalesGraphComponent),
    }),
  ],
})
export class FrequentlyOrderedUIModule {}

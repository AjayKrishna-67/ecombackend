import { Component } from '@angular/core';
import { FormControl } from '@angular/forms';
import { FormInputComponent } from '@vendure/admin-ui/core';

/**
 * No-op custom-field control for `Product.productStockEnabled`.
 *
 * The real enable/disable toggle lives inside the Product Stock detail block
 * (see ProductStockComponent). Registering this empty component for the field's
 * `ui.component` id prevents the Admin UI from rendering a duplicate default
 * boolean checkbox in the Custom Fields card. Mirrors the React dashboard, which
 * registers a `() => null` component for the same id.
 */
@Component({
  selector: 'product-stock-toggle-suppressed',
  standalone: true,
  template: ``,
})
export class ProductStockToggleSuppressedComponent implements FormInputComponent {
  readonly = false;
  formControl!: FormControl;
  config: any;

  static readonly id = 'product-stock-toggle-suppressed';
}

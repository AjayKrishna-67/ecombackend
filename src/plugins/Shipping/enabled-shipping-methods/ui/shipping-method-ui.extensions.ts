import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { SharedModule } from '@vendure/admin-ui/core';
import { ShippingMethodToggleComponent } from './shipping-method-toggle.component';

@NgModule({
  imports: [CommonModule, ReactiveFormsModule, SharedModule, ShippingMethodToggleComponent],
  exports: [ShippingMethodToggleComponent],
})
export class ShippingMethodUiModule {}

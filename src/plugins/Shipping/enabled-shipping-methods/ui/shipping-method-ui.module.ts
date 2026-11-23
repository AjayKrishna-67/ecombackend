import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { ShippingMethodToggleComponent } from './shipping-method-toggle.component';

@NgModule({
  imports: [CommonModule, ReactiveFormsModule],
  declarations: [ShippingMethodToggleComponent],
  exports: [ShippingMethodToggleComponent],
})
export class ShippingMethodUIModule {}

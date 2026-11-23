import { Component, ElementRef, OnInit } from '@angular/core';
import { FormControl } from '@angular/forms';
import { FormInputComponent } from '@vendure/admin-ui/core';

import { findFieldRowWrapper } from './field-row-util';
import { StoreLocationBridge } from './store-location-bridge.service';

/**
 * Invisible input for the ShippingMethod store-location custom fields
 * (storeLatitude/longitude/address/mapUrl/takeAwayCouponCode). Hides its own
 * field row and registers its form control with the StoreLocationBridge, so
 * the picker inside the Calculator card can read/write the values. Writing
 * through these real controls marks the detail form dirty, which is what
 * enables the Create/Update button.
 */
@Component({
    selector: 'take-away-field-bridge',
    standalone: true,
    template: ``,
})
export class TakeAwayFieldBridgeComponent implements FormInputComponent, OnInit {
    readonly = false;
    formControl!: FormControl;
    config: any;

    static readonly id = 'take-away-field-bridge';

    constructor(private el: ElementRef<HTMLElement>, private bridge: StoreLocationBridge) {}

    ngOnInit() {
        findFieldRowWrapper(this.el.nativeElement).style.display = 'none';
        if (this.config?.name) {
            this.bridge.register(this.config.name, this.formControl);
        }
    }
}

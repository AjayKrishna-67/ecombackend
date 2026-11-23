import { Component, ElementRef, OnInit } from '@angular/core';
import { FormControl } from '@angular/forms';
import { FormInputComponent } from '@vendure/admin-ui/core';

import { findFieldRowWrapper } from './field-row-util';

/**
 * No-op control for `ShippingMethod.storeLongitude` / `storeMapUrl` — both are
 * written by the Store Location Pin map component, so their own form rows
 * (label + description included) should not appear at all. On init this
 * component climbs the DOM to the outermost wrapper that contains no OTHER
 * form controls and hides it — so it can never accidentally hide sibling
 * fields like the map or the address, whatever the surrounding markup is.
 */
@Component({
    selector: 'take-away-suppressed-input',
    standalone: true,
    template: ``,
})
export class TakeAwaySuppressedInputComponent implements FormInputComponent, OnInit {
    readonly = false;
    formControl!: FormControl;
    config: any;

    static readonly id = 'take-away-suppressed-input';

    constructor(private el: ElementRef<HTMLElement>) {}

    ngOnInit() {
        findFieldRowWrapper(this.el.nativeElement).style.display = 'none';
    }
}

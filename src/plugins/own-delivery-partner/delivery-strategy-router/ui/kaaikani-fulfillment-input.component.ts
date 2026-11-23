import { Component, OnInit, AfterViewInit, ElementRef, ViewEncapsulation, ChangeDetectorRef } from '@angular/core';
import { FormControl } from '@angular/forms';
import { FormInputComponent, SharedModule, DataService } from '@vendure/admin-ui/core';
import { CommonModule } from '@angular/common';
import gql from 'graphql-tag';

const GET_DELIVERY_PERSONS = gql`
    query GetDeliveryPersons {
        deliveryPersons {
            id
            firstName
            lastName
            phoneNumber
        }
    }
`;

const GET_ORDER_PICKUP_INFO = gql`
    query GetOrderPickupInfo($id: ID!) {
        order(id: $id) {
            id
            shippingLines {
                shippingMethod {
                    id
                    customFields {
                        storeLatitude
                    }
                }
            }
        }
    }
`;

@Component({
    selector: 'kaaikani-fulfillment-input',
    standalone: true,
    imports: [CommonModule, SharedModule],
    encapsulation: ViewEncapsulation.None,
    template: `
        <div class="kf">
            <label class="kf-label">Delivery Method</label>
            <select class="kf-select" [(ngModel)]="selectedType" (ngModelChange)="onTypeChange()">
                <option value="" disabled>-- Select Delivery Method --</option>
                <option value="own-delivery-fleet">Own Delivery Fleet</option>
                <option value="shiprocket-quick">Shiprocket Quick</option>
                <option value="adloggs">Adloggs</option>
                <option value="manual">Take Away (Manual)</option>
            </select>

            <ng-container *ngIf="selectedType === 'own-delivery-fleet'">
                <label class="kf-label">Delivery Person</label>
                <select class="kf-select" [(ngModel)]="selectedPersonId" (ngModelChange)="onPersonChange()">
                    <option value="" disabled>-- Select Delivery Person --</option>
                    <option *ngFor="let p of deliveryPersons" [value]="p.id">
                        {{ p.firstName }} {{ p.lastName }}  ·  {{ p.phoneNumber || '' }}
                    </option>
                </select>
            </ng-container>
        </div>
    `,
    styles: [`
        .kf {
            display: flex;
            flex-direction: column;
            gap: 6px;
            width: 100%;
        }
        .kf-label {
            font-size: 12px;
            font-weight: 600;
            color: var(--color-text-200, #a0aec0);
            margin-top: 4px;
        }
        .kf-select {
            width: 100%;
            padding: 6px 8px;
            border: 1px solid var(--color-component-border-300, #4a5568);
            border-radius: 3px;
            background: var(--color-component-bg-100, #1a202c);
            color: var(--color-text-100, #e2e8f0);
            font-size: 13px;
            outline: none;
            cursor: pointer;
            box-sizing: border-box;
        }
        .kf-select:focus {
            border-color: var(--color-primary-500, #4299e1);
        }
        .kf-select option {
            background: var(--color-component-bg-100, #1a202c);
            color: var(--color-text-100, #e2e8f0);
        }
    `],
})
export class KaaikaniFulfillmentInputComponent implements FormInputComponent, OnInit, AfterViewInit {
    readonly!: boolean;
    formControl!: FormControl;
    config: any;

    selectedType = '';
    selectedPersonId = '';
    deliveryPersons: any[] = [];

    static readonly id = 'kaaikani-fulfillment-input';

    constructor(
        private dataService: DataService,
        private elementRef: ElementRef,
        private changeDetector: ChangeDetectorRef,
    ) { }

    ngOnInit() {
        if (this.formControl.value) {
            try {
                const v = typeof this.formControl.value === 'string'
                    ? JSON.parse(this.formControl.value) : this.formControl.value;
                this.selectedType = v.type || 'own-delivery-fleet';
                this.selectedPersonId = v.deliveryPersonId || '';
            } catch (e) { /* ignore */ }
        }
        this.syncValue();
        this.preselectTakeAwayIfPickupOrder();

        this.dataService.query(GET_DELIVERY_PERSONS).single$.subscribe({
            next: (result: any) => {
                this.deliveryPersons = result.deliveryPersons || [];
                this.changeDetector.markForCheck();
            },
            error: () => { },
        });
    }

    ngAfterViewInit() {
        // Walk up the DOM and hide any label siblings, expand the container
        setTimeout(() => {
            let el = this.elementRef.nativeElement as HTMLElement;
            // Walk up to 10 levels
            for (let i = 0; i < 10 && el?.parentElement; i++) {
                el = el.parentElement;
                // Find and hide label children of this parent
                const labels = el.querySelectorAll(':scope > label');
                labels.forEach((label: Element) => {
                    (label as HTMLElement).style.display = 'none';
                });
                // Expand container siblings
                const containers = el.querySelectorAll(':scope > .clr-control-container, :scope > [class*="col-md"]');
                containers.forEach((c: Element) => {
                    (c as HTMLElement).style.width = '100%';
                    (c as HTMLElement).style.maxWidth = '100%';
                    (c as HTMLElement).style.flex = '0 0 100%';
                    (c as HTMLElement).style.paddingLeft = '0';
                });
                // If we found and hid a label, good enough — stop
                if (labels.length > 0) break;
            }
        }, 0);
    }

    /**
     * The fulfillment dialog opens on the order-detail route. If that order's
     * shipping method is a Take Away pickup method (store pinned — see the
     * take-away plugin), default the picker to "Take Away (Manual)". Staff
     * can still change it; an already-chosen value is never overridden.
     */
    private preselectTakeAwayIfPickupOrder() {
        if (this.selectedType) {
            return;
        }
        const match = window.location.href.match(/\/orders\/(\d+)/);
        if (!match) {
            return;
        }
        this.dataService.query<any>(GET_ORDER_PICKUP_INFO, { id: match[1] }).single$.subscribe({
            next: result => {
                const isPickup = (result.order?.shippingLines ?? []).some(
                    (line: any) => line.shippingMethod?.customFields?.storeLatitude != null,
                );
                if (isPickup && !this.selectedType) {
                    this.selectedType = 'manual';
                    this.syncValue();
                    this.changeDetector.markForCheck();
                }
            },
            error: () => { },
        });
    }

    onTypeChange() {
        if (this.selectedType !== 'own-delivery-fleet') this.selectedPersonId = '';
        this.syncValue();
    }

    onPersonChange() {
        this.syncValue();
    }

    private syncValue() {
        this.formControl.setValue(JSON.stringify({
            type: this.selectedType,
            deliveryPersonId: this.selectedPersonId,
        }));
        this.formControl.markAsDirty();
    }
}

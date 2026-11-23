import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { FormGroup } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { CustomDetailComponent, DataService, SharedModule } from '@vendure/admin-ui/core';
import gql from 'graphql-tag';
import { Observable } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';

const GET_ORDER_SHIPPING_LOCATION = gql`
    query GetOrderShippingLocation($id: ID!) {
        order(id: $id) {
            id
            customFields {
                isTakeAway
                pickupAddress
                pickupLatitude
                pickupLongitude
            }
            shippingAddress {
                customFields {
                    latitude
                    longitude
                }
            }
        }
    }
`;

interface PinLocation {
    title: string;
    addressLine: string | null;
    lat: number;
    lng: number;
    embedUrl: SafeResourceUrl;
    externalUrl: string;
}

@Component({
    selector: 'order-location-map',
    standalone: true,
    imports: [SharedModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <vdr-card [title]="loc.title" *ngIf="location$ | async as loc">
            <div class="address-line" *ngIf="loc.addressLine">
                <clr-icon shape="store"></clr-icon> {{ loc.addressLine }}
            </div>
            <iframe
                [src]="loc.embedUrl"
                width="100%"
                height="320"
                style="border: 0; border-radius: 4px;"
                loading="lazy"
                referrerpolicy="no-referrer-when-downgrade"
            ></iframe>
            <div class="map-footer">
                <span class="coords">{{ loc.lat }}, {{ loc.lng }}</span>
                <a [href]="loc.externalUrl" target="_blank" rel="noopener">
                    <clr-icon shape="map-marker"></clr-icon>
                    Open in Google Maps
                </a>
            </div>
        </vdr-card>
    `,
    styles: [
        `
            .address-line {
                margin-bottom: 6px;
                font-size: 13px;
            }
            .map-footer {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-top: 6px;
            }
            .coords {
                color: var(--color-text-300, #6b7280);
                font-size: 12px;
            }
        `,
    ],
})
export class OrderLocationMapComponent implements CustomDetailComponent, OnInit {
    entity$!: Observable<any>;
    detailForm!: FormGroup;
    location$!: Observable<PinLocation | null>;

    constructor(private dataService: DataService, private sanitizer: DomSanitizer) {}

    ngOnInit() {
        this.location$ = this.entity$.pipe(
            switchMap(order =>
                this.dataService
                    .query<any>(GET_ORDER_SHIPPING_LOCATION, { id: order.id })
                    .mapStream(data => data.order),
            ),
            map(order => {
                // Take Away order: show the pickup store (snapshotted from the
                // shipping method at order placement) instead of the customer's
                // delivery pin.
                const oc = order?.customFields;
                if (oc?.isTakeAway && oc.pickupLatitude != null && oc.pickupLongitude != null) {
                    // The pickup time is shown in the order table's Shipping
                    // row by OrderPickupTimeRowComponent.
                    return this.toPin(oc.pickupLatitude, oc.pickupLongitude, {
                        title: 'Pickup store (Take Away)',
                        addressLine: oc.pickupAddress ?? null,
                    });
                }
                const lat = order?.shippingAddress?.customFields?.latitude;
                const lng = order?.shippingAddress?.customFields?.longitude;
                if (lat == null || lng == null) {
                    return null;
                }
                return this.toPin(lat, lng, { title: 'Delivery location', addressLine: null });
            }),
        );
    }

    private toPin(lat: number, lng: number, opts: { title: string; addressLine: string | null }): PinLocation {
        return {
            title: opts.title,
            addressLine: opts.addressLine,
            lat,
            lng,
            embedUrl: this.sanitizer.bypassSecurityTrustResourceUrl(
                `https://maps.google.com/maps?q=${lat},${lng}&z=16&output=embed`,
            ),
            externalUrl: `https://www.google.com/maps?q=${lat},${lng}`,
        };
    }
}

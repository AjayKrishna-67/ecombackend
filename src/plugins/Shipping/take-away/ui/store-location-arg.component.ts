import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormControl, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { DataService, FormInputComponent, SharedModule } from '@vendure/admin-ui/core';
import gql from 'graphql-tag';
import { Subscription } from 'rxjs';

import {
    EMPTY_PARTS,
    HOURS,
    joinPickupTime,
    MERIDIEMS,
    MINUTES,
    pickupWindowMessage,
    splitPickupTime,
    TimeParts,
} from './pickup-time';
import { StoreLocationBridge } from './store-location-bridge.service';

const GET_GOOGLE_MAPS_API_KEY = gql`
    query GetGoogleMapsApiKey {
        googleMapsApiKey
    }
`;

declare const window: any;

/** Loads the Google Maps JS API once per admin session. */
function loadGoogleMaps(apiKey: string): Promise<any> {
    if (window.google?.maps) {
        return Promise.resolve(window.google.maps);
    }
    if (!window.__takeAwayGmapsLoader) {
        window.__takeAwayGmapsLoader = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly`;
            script.async = true;
            script.onload = () => resolve(window.google.maps);
            script.onerror = () => reject(new Error('Failed to load Google Maps JS API'));
            document.head.appendChild(script);
        });
    }
    return window.__takeAwayGmapsLoader;
}

/**
 * The Store Location picker, rendered INSIDE the Calculator card as the
 * take-away calculator's `storeLocation` arg component. The arg itself holds
 * no data — everything is written to the ShippingMethod custom fields through
 * the StoreLocationBridge (whose controls are registered by the hidden
 * TakeAwayFieldBridgeComponent instances). Writing those real controls marks
 * the detail form dirty, enabling the Create/Update button.
 *
 * Pin via map click/drag (Google, needs GOOGLE_MAPS_API_KEY), pincode search
 * (Google Geocoder / Nominatim fallback), or GPS; every pin reverse-geocodes
 * to auto-fill the empty Store Address. Also edits the coupon-code binding
 * and the address here, since their custom-field rows are hidden.
 */
@Component({
    selector: 'take-away-store-location-arg',
    standalone: true,
    imports: [SharedModule, ReactiveFormsModule, FormsModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="store-map-input">
            <div class="toolbar">
                <input
                    type="text"
                    class="pincode-input"
                    placeholder="Pincode e.g. 625001"
                    #pincodeInput
                    maxlength="6"
                    [disabled]="readonly || locating"
                    (keydown.enter)="$event.preventDefault(); locatePincode(pincodeInput.value)"
                />
                <button type="button" class="button-small" [disabled]="readonly || locating"
                    (click)="locatePincode(pincodeInput.value)">
                    <clr-icon shape="search"></clr-icon> Locate pincode
                </button>
                <button type="button" class="button-small" [disabled]="readonly || locating" (click)="useGps()">
                    <clr-icon shape="crosshairs"></clr-icon> Use GPS
                </button>
                <span class="spinner spinner-inline" *ngIf="locating"></span>
            </div>
            <div class="zone-label" *ngIf="zoneLabel">
                <clr-icon shape="map-marker"></clr-icon> {{ zoneLabel }}
            </div>
            <div class="hint" *ngIf="interactive && !readonly">
                Click anywhere on the map to pin the store; drag the marker to adjust.
            </div>
            <div class="error" *ngIf="errorMsg">{{ errorMsg }}</div>

            <div #mapContainer class="map-canvas" [class.hidden]="!interactive"></div>
            <iframe
                *ngIf="!interactive && embedUrl"
                [src]="embedUrl"
                width="100%"
                height="320"
                style="border: 0; border-radius: 4px;"
                loading="lazy"
                referrerpolicy="no-referrer-when-downgrade"
            ></iframe>

            <div class="coords-row" *ngIf="lat != null && lng != null">
                <span class="coords">Pinned: {{ lat }}, {{ lng }}</span>
                <a [href]="'https://www.google.com/maps?q=' + lat + ',' + lng" target="_blank" rel="noopener">
                    <clr-icon shape="pop-out"></clr-icon> Open in Google Maps
                </a>
                <button type="button" class="button-small" *ngIf="!readonly" (click)="clearPin()">Clear pin</button>
            </div>

            <label class="field-label" *ngIf="addressControl as ac">
                Store Address (shown to the customer)
                <textarea class="field-input field-textarea" [formControl]="ac"></textarea>
            </label>
            <label class="field-label" *ngIf="couponControl as cc">
                Take Away Coupon Code (optional — must equal this method's promotion coupon code)
                <input type="text" class="field-input" [formControl]="cc" />
            </label>
            <label class="field-label" *ngIf="phonesControl as pc">
                Order Notification Numbers (comma-separated — each gets a WhatsApp alert on new orders)
                <input type="text" class="field-input" placeholder="9840012345, 9840067890" [formControl]="pc" />
            </label>
            <label class="field-label" *ngIf="notifyTemplateControl as nc">
                Notification WhatsApp Template (approved MSG91 template for the staff alert, e.g. new_order_alert)
                <input type="text" class="field-input" placeholder="new_order_alert" [formControl]="nc" />
            </label>
            <div class="field-label" *ngIf="pickupSlotControl">
                Pickup Time (shown to the customer — the same window every day)
                <div class="time-rows">
                    <div class="time-row" *ngFor="let end of timeEnds">
                        <span class="time-word">{{ end === 'from' ? 'From' : 'To' }}</span>
                        <select
                            class="time-select"
                            [disabled]="readonly"
                            [ngModel]="timeParts[end].hour"
                            [ngModelOptions]="{ standalone: true }"
                            (ngModelChange)="onTimePart(end, 'hour', $event)"
                        >
                            <option value="">Hour</option>
                            <option *ngFor="let h of hours" [value]="h">{{ h }}</option>
                        </select>
                        <select
                            class="time-select"
                            [disabled]="readonly"
                            [ngModel]="timeParts[end].minute"
                            [ngModelOptions]="{ standalone: true }"
                            (ngModelChange)="onTimePart(end, 'minute', $event)"
                        >
                            <option value="">Min</option>
                            <option *ngFor="let m of minutes" [value]="m">{{ m }}</option>
                        </select>
                        <select
                            class="time-select"
                            [disabled]="readonly"
                            [ngModel]="timeParts[end].meridiem"
                            [ngModelOptions]="{ standalone: true }"
                            (ngModelChange)="onTimePart(end, 'meridiem', $event)"
                        >
                            <option value="">AM/PM</option>
                            <option *ngFor="let ap of meridiems" [value]="ap">{{ ap }}</option>
                        </select>
                    </div>
                    <div class="time-row">
                        <span class="hint" *ngIf="pickupWindowText && !pickupWindowError">
                            Customers see: {{ pickupWindowText }}
                        </span>
                        <span class="error" *ngIf="pickupWindowError">{{ pickupWindowError }}</span>
                        <button
                            type="button"
                            class="button-small"
                            *ngIf="!readonly && (timeParts.from.hour || timeParts.to.hour)"
                            (click)="clearPickupTime()"
                        >
                            Clear
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `,
    styles: [
        `
            .store-map-input {
                display: flex;
                flex-direction: column;
                gap: 8px;
                max-width: 720px;
            }
            .toolbar {
                display: flex;
                gap: 8px;
                align-items: center;
            }
            .pincode-input {
                width: 160px;
                padding: 4px 8px;
                border: 1px solid var(--color-component-border-100, #d1d5db);
                border-radius: 3px;
            }
            .zone-label {
                font-size: 13px;
                color: var(--color-text-200, #374151);
            }
            .hint {
                font-size: 12px;
                color: var(--color-text-300, #6b7280);
            }
            .error {
                color: var(--color-error-500, #dc2626);
                font-size: 12px;
            }
            .map-canvas {
                width: 100%;
                height: 320px;
                border-radius: 4px;
            }
            .map-canvas.hidden {
                display: none;
            }
            .coords-row {
                display: flex;
                align-items: center;
                gap: 16px;
                font-size: 13px;
            }
            .coords {
                color: var(--color-text-300, #6b7280);
            }
            .field-label {
                display: flex;
                flex-direction: column;
                gap: 4px;
                font-size: 12px;
                font-weight: 600;
                color: var(--color-text-200, #374151);
            }
            .field-input {
                width: 100%;
                padding: 6px 8px;
                border: 1px solid var(--color-component-border-100, #d1d5db);
                border-radius: 3px;
                font-size: 13px;
                font-weight: 400;
                box-sizing: border-box;
            }
            .field-textarea {
                min-height: 56px;
                resize: vertical;
            }
            .time-rows {
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .time-row {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 8px;
                font-weight: 400;
            }
            .time-word {
                width: 40px;
                font-size: 13px;
                color: var(--color-text-200, #374151);
            }
            .time-select {
                flex: 1 1 90px;
                min-width: 90px;
                max-width: 140px;
                padding: 6px 8px;
                border: 1px solid var(--color-component-border-100, #d1d5db);
                border-radius: 3px;
                font-size: 13px;
                background: var(--color-component-bg-100, #fff);
            }
        `,
    ],
})
export class StoreLocationArgComponent implements FormInputComponent, OnInit, OnDestroy {
    readonly = false;
    formControl!: FormControl;
    config: any;

    @ViewChild('mapContainer', { static: true }) mapContainer!: ElementRef<HTMLDivElement>;

    interactive = false;
    locating = false;
    errorMsg = '';
    zoneLabel = '';
    embedUrl: SafeResourceUrl | null = null;

    private map: any;
    private marker: any;
    private keySub?: Subscription;
    private bridgeSub?: Subscription;
    private mapInitStarted = false;

    static readonly id = 'take-away-store-location-arg';

    constructor(
        private dataService: DataService,
        private sanitizer: DomSanitizer,
        private zone: NgZone,
        private cdr: ChangeDetectorRef,
        private bridge: StoreLocationBridge,
    ) {}

    get latControl() {
        return this.bridge.get('storeLatitude');
    }
    get lngControl() {
        return this.bridge.get('storeLongitude');
    }
    get addressControl() {
        return this.bridge.get('storeAddress');
    }
    get couponControl() {
        return this.bridge.get('takeAwayCouponCode');
    }
    get phonesControl() {
        return this.bridge.get('notificationPhones');
    }
    get notifyTemplateControl() {
        return this.bridge.get('notificationWhatsappTemplate');
    }
    get pickupSlotControl() {
        return this.bridge.get('pickupSlot');
    }

    // Pickup Time dropdowns. The parts are the editor's working state; the
    // window itself is written to the bridged `pickupSlot` control on every
    // change, as `{ from, to }` text the server validates.
    readonly timeEnds: Array<'from' | 'to'> = ['from', 'to'];
    readonly hours = HOURS;
    readonly minutes = MINUTES;
    readonly meridiems = MERIDIEMS;
    timeParts: { from: TimeParts; to: TimeParts } = { from: { ...EMPTY_PARTS }, to: { ...EMPTY_PARTS } };
    private timePartsSynced = false;

    get pickupWindowText(): string {
        const from = joinPickupTime(this.timeParts.from);
        const to = joinPickupTime(this.timeParts.to);
        return from && to ? `${from} - ${to}` : '';
    }

    get pickupWindowError(): string {
        return pickupWindowMessage(joinPickupTime(this.timeParts.from), joinPickupTime(this.timeParts.to));
    }

    /** Fill the dropdowns from the stored window once the bridge control exists. */
    private syncTimePartsFromControl() {
        const control = this.pickupSlotControl;
        if (!control || this.timePartsSynced) {
            return;
        }
        const value = control.value ?? {};
        this.timeParts = { from: splitPickupTime(value.from), to: splitPickupTime(value.to) };
        this.timePartsSynced = true;
    }

    onTimePart(end: 'from' | 'to', part: keyof TimeParts, value: string) {
        this.timeParts = { ...this.timeParts, [end]: { ...this.timeParts[end], [part]: value ?? '' } };
        this.writePickupTime();
    }

    clearPickupTime() {
        this.timeParts = { from: { ...EMPTY_PARTS }, to: { ...EMPTY_PARTS } };
        this.writePickupTime();
    }

    private writePickupTime() {
        // A half-set end is written as null so the server's own message
        // ("set both ends") appears on save if the admin leaves it that way.
        this.setControl(this.pickupSlotControl, {
            from: joinPickupTime(this.timeParts.from),
            to: joinPickupTime(this.timeParts.to),
        });
        this.cdr.markForCheck();
    }

    get lat(): number | null {
        const v = this.latControl?.value;
        return typeof v === 'number' ? v : null;
    }

    get lng(): number | null {
        const v = this.lngControl?.value;
        return typeof v === 'number' ? v : null;
    }

    ngOnInit() {
        this.updateEmbed();
        this.syncTimePartsFromControl();
        // Custom-field bridge controls may register after this component
        // initializes — refresh the view (and map pin) as they arrive.
        this.bridgeSub = this.bridge.changes$.subscribe(() => {
            this.updateEmbed();
            this.syncTimePartsFromControl();
            if (this.interactive && this.lat != null && this.lng != null && window.google?.maps) {
                this.placeMarker(window.google.maps, { lat: this.lat, lng: this.lng });
                this.map?.setCenter({ lat: this.lat, lng: this.lng });
                this.map?.setZoom(16);
            }
            this.cdr.markForCheck();
        });
        this.keySub = this.dataService
            .query<{ googleMapsApiKey: string }>(GET_GOOGLE_MAPS_API_KEY)
            .single$.subscribe({
                next: ({ googleMapsApiKey }) => {
                    if (googleMapsApiKey) {
                        void this.initMap(googleMapsApiKey);
                    } else {
                        this.cdr.markForCheck();
                    }
                },
                error: () => this.cdr.markForCheck(),
            });
    }

    ngOnDestroy() {
        this.keySub?.unsubscribe();
        this.bridgeSub?.unsubscribe();
    }

    private async initMap(apiKey: string) {
        if (this.mapInitStarted) {
            return;
        }
        this.mapInitStarted = true;
        // Google reports invalid keys / blocked referrers via this global
        // callback AFTER the script loads — without it the map just goes
        // blank with no visible error.
        window.gm_authFailure = () => {
            this.zone.run(() => {
                this.interactive = false;
                this.errorMsg =
                    'Google Maps rejected the API key. In Google Cloud check: Maps JavaScript API is enabled, billing is active, and the key’s website restrictions include this URL (e.g. http://localhost:3001/*).';
                this.updateEmbed();
                this.cdr.markForCheck();
            });
        };
        try {
            const maps = await loadGoogleMaps(apiKey);
            this.interactive = true;
            const hasPin = this.lat != null && this.lng != null;
            // Default view: south India, matching the store regions.
            const center = hasPin ? { lat: this.lat!, lng: this.lng! } : { lat: 10.5, lng: 78.2 };
            this.map = new maps.Map(this.mapContainer.nativeElement, {
                center,
                zoom: hasPin ? 16 : 7,
                streetViewControl: false,
                mapTypeControl: false,
            });
            if (hasPin) {
                this.placeMarker(maps, center);
            }
            if (!this.readonly) {
                this.map.addListener('click', (e: any) => {
                    this.zone.run(() => this.setPin(e.latLng.lat(), e.latLng.lng()));
                });
            }
            this.cdr.markForCheck();
        } catch (e: any) {
            this.interactive = false;
            this.errorMsg = `Could not load Google Maps (${e?.message ?? 'unknown error'}). Pincode and GPS still work.`;
            this.cdr.markForCheck();
        }
    }

    private placeMarker(maps: any, position: { lat: number; lng: number }) {
        if (this.marker) {
            this.marker.setPosition(position);
            return;
        }
        this.marker = new maps.Marker({
            position,
            map: this.map,
            draggable: !this.readonly,
        });
        this.marker.addListener('dragend', (e: any) => {
            this.zone.run(() => this.setPin(e.latLng.lat(), e.latLng.lng()));
        });
    }

    setPin(lat: number, lng: number, opts?: { zoneLabel?: string; zoom?: number; embedQuery?: string }) {
        const round = (n: number) => Math.round(n * 1e6) / 1e6;
        lat = round(lat);
        lng = round(lng);
        this.errorMsg = '';
        this.zoneLabel = opts?.zoneLabel ?? '';
        this.setControl(this.latControl, lat);
        this.setControl(this.lngControl, lng);
        if (this.interactive && window.google?.maps) {
            this.placeMarker(window.google.maps, { lat, lng });
            this.map?.panTo({ lat, lng });
            if (opts?.zoom) {
                this.map?.setZoom(opts.zoom);
            }
        }
        this.updateEmbed(opts?.embedQuery, opts?.zoom);
        // Direct pin (map click, drag, GPS): look up the address for it.
        if (!opts?.zoneLabel && this.interactive && window.google?.maps) {
            void this.reverseGeocode(lat, lng);
        }
        this.cdr.markForCheck();
    }

    private setControl(control: FormControl | undefined, value: any) {
        if (control) {
            control.setValue(value);
            control.markAsDirty();
        }
    }

    /** Pin → address. Shows it and fills Store Address when that is empty. */
    private async reverseGeocode(lat: number, lng: number) {
        try {
            const geocoder = new window.google.maps.Geocoder();
            const { results } = await geocoder.geocode({ location: { lat, lng } });
            const address = results?.[0]?.formatted_address;
            if (address) {
                this.applyResolvedAddress(address);
            }
        } catch (e: any) {
            // Address lookup is best-effort; the pin itself is already set.
            if (String(e?.message ?? e).includes('REQUEST_DENIED')) {
                this.errorMsg = 'Address lookup failed: enable the Geocoding API for this key in Google Cloud.';
                this.cdr.markForCheck();
            }
        }
    }

    private applyResolvedAddress(address: string) {
        // Display only — the admin types the Store Address themselves
        // (auto-filling it was explicitly not wanted).
        this.zoneLabel = address;
        this.cdr.markForCheck();
    }

    clearPin() {
        this.setControl(this.latControl, null);
        this.setControl(this.lngControl, null);
        this.marker?.setMap(null);
        this.marker = undefined;
        this.zoneLabel = '';
        this.updateEmbed();
        this.cdr.markForCheck();
    }

    /** Pincode → coordinates + zone. Google Geocoder with a key, Nominatim without. */
    async locatePincode(pincodeRaw: string) {
        const pincode = (pincodeRaw ?? '').trim();
        this.errorMsg = '';
        if (!/^\d{6}$/.test(pincode)) {
            this.errorMsg = 'Enter a valid 6-digit pincode.';
            this.cdr.markForCheck();
            return;
        }
        this.locating = true;
        this.cdr.markForCheck();
        try {
            if (this.interactive && window.google?.maps) {
                const geocoder = new window.google.maps.Geocoder();
                const { results } = await geocoder.geocode({
                    componentRestrictions: { postalCode: pincode, country: 'IN' },
                });
                const best = results?.[0];
                if (!best) {
                    throw new Error('not found');
                }
                const loc = best.geometry.location;
                this.setPin(loc.lat(), loc.lng(), {
                    zoneLabel: best.formatted_address,
                    embedQuery: pincode,
                });
                this.applyResolvedAddress(best.formatted_address);
                if (best.geometry.viewport) {
                    this.map?.fitBounds(best.geometry.viewport);
                }
            } else {
                // Nominatim: postalcode search first, free-text as fallback
                // (Indian pincode coverage differs between the two indexes).
                let best = await this.nominatim(`postalcode=${pincode}&countrycodes=in`);
                if (!best) {
                    best = await this.nominatim(`q=${encodeURIComponent(pincode + ', India')}&countrycodes=in`);
                }
                if (!best) {
                    throw new Error('not found');
                }
                this.setPin(parseFloat(best.lat), parseFloat(best.lon), {
                    zoneLabel: best.display_name,
                    zoom: 13,
                    embedQuery: pincode,
                });
            }
        } catch (e: any) {
            this.errorMsg = `Could not locate pincode ${pincode}${e?.message === 'not found' ? '' : ` (${e?.message})`}. Check the pincode or try GPS.`;
        } finally {
            this.locating = false;
            this.cdr.markForCheck();
        }
    }

    private async nominatim(params: string): Promise<any | undefined> {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}&format=jsonv2&limit=1`, {
            headers: { Accept: 'application/json' },
        });
        const data = await res.json();
        return data?.[0];
    }

    /** Browser geolocation → auto-pin (needs https or localhost). */
    useGps() {
        this.errorMsg = '';
        if (!window.isSecureContext) {
            // Browsers block geolocation on plain-http non-localhost origins
            // (e.g. opening the admin via a LAN IP).
            this.errorMsg =
                'GPS only works over HTTPS or on localhost. Open the admin via http://localhost instead of the IP address, or use pincode.';
            this.cdr.markForCheck();
            return;
        }
        if (!navigator.geolocation) {
            this.errorMsg = 'This browser does not support geolocation.';
            this.cdr.markForCheck();
            return;
        }
        this.locating = true;
        this.cdr.markForCheck();
        navigator.geolocation.getCurrentPosition(
            pos => {
                this.zone.run(() => {
                    this.locating = false;
                    this.setPin(pos.coords.latitude, pos.coords.longitude, {
                        zoneLabel: 'Pinned from GPS.',
                        zoom: 17,
                    });
                });
            },
            err => {
                this.zone.run(() => {
                    this.locating = false;
                    this.errorMsg =
                        err.code === err.PERMISSION_DENIED
                            ? 'Location permission denied — allow it in the browser, or use pincode instead.'
                            : 'Could not get GPS position — use pincode instead.';
                    this.cdr.markForCheck();
                });
            },
            { enableHighAccuracy: true, timeout: 15000 },
        );
    }

    /**
     * Keyless embed preview: the pincode's zone, the exact pin, or a
     * south-India overview — so a map is always visible.
     */
    private updateEmbed(query?: string, zoom?: number) {
        const q = query
            ? `${encodeURIComponent(query)},India`
            : this.lat != null && this.lng != null
              ? `${this.lat},${this.lng}`
              : 'Tamil+Nadu,India';
        const z = zoom ?? (query ? 12 : this.lat != null ? 16 : 7);
        this.embedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(
            `https://maps.google.com/maps?q=${q}&z=${z}&output=embed`,
        );
    }
}

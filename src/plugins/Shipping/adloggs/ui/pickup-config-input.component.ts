import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { FormControl } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { DataService, FormInputComponent, SharedModule } from '@vendure/admin-ui/core';
import gql from 'graphql-tag';
import { Subscription } from 'rxjs';

const GET_GOOGLE_MAPS_API_KEY = gql`
    query AdloggsGoogleMapsApiKey {
        googleMapsApiKey
    }
`;

declare const window: any;

/** Loads the Google Maps JS API once per admin session (shared loader key with take-away). */
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

/** The JSON stored in the calculator's `pickupConfig` arg. */
interface PickupConfig {
    name: string;
    phone: string;
    address: string;
    lat: number | null;
    long: number | null;
    pincode: string;
    city: string;
    state: string;
}

interface ResolvedPlace {
    address: string;
    pincode: string;
    city: string;
    state: string;
}

const EMPTY: PickupConfig = { name: '', phone: '', address: '', lat: null, long: null, pincode: '', city: '', state: '' };

function fromGoogleResult(result: any): ResolvedPlace {
    const comps: any[] = result?.address_components ?? [];
    const pick = (...types: string[]) => comps.find(c => types.some(t => c.types?.includes(t)))?.long_name ?? '';
    return {
        address: result?.formatted_address ?? '',
        pincode: pick('postal_code'),
        city: pick('locality', 'administrative_area_level_3', 'administrative_area_level_2'),
        state: pick('administrative_area_level_1'),
    };
}

function fromNominatimResult(result: any): ResolvedPlace {
    const a = result?.address ?? {};
    return {
        address: result?.display_name ?? '',
        pincode: a.postcode ?? '',
        city: a.city || a.town || a.village || a.county || a.state_district || '',
        state: a.state ?? '',
    };
}

/**
 * Adloggs "Pickup Store" picker — the calculator's `pickupConfig` arg
 * component (Angular admin). Pin the store on the map (click/drag with a
 * Google key; pincode search or GPS otherwise); every pin reverse-geocodes
 * and auto-fills latitude/longitude, pincode, city, state (and the address
 * when empty). Contact name and phone are typed below the map. Everything is
 * written as one JSON string to the arg's form control.
 */
@Component({
    selector: 'adloggs-pickup-config-input',
    standalone: true,
    imports: [SharedModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="pickup-input">
            <div class="toolbar">
                <input type="text" class="pincode-input" placeholder="Pincode e.g. 641012" #pincodeInput maxlength="6"
                    [disabled]="readonly || locating"
                    (keydown.enter)="$event.preventDefault(); locatePincode(pincodeInput.value)" />
                <button type="button" class="button-small" [disabled]="readonly || locating" (click)="locatePincode(pincodeInput.value)">
                    <clr-icon shape="search"></clr-icon> Locate pincode
                </button>
                <button type="button" class="button-small" [disabled]="readonly || locating" (click)="useGps()">
                    <clr-icon shape="crosshairs"></clr-icon> Use GPS
                </button>
                <span class="spinner spinner-inline" *ngIf="locating"></span>
            </div>
            <div class="zone-label" *ngIf="zoneLabel"><clr-icon shape="map-marker"></clr-icon> {{ zoneLabel }}</div>
            <div class="hint" *ngIf="interactive && !readonly">
                Click anywhere on the map to pin the store; drag the marker to adjust. Pincode, city and state fill in automatically.
            </div>
            <div class="error" *ngIf="errorMsg">{{ errorMsg }}</div>

            <div #mapContainer class="map-canvas" [class.hidden]="!interactive"></div>
            <iframe *ngIf="!interactive && embedUrl" [src]="embedUrl" width="100%" height="320"
                style="border: 0; border-radius: 4px;" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>

            <div class="coords-row" *ngIf="cfg.lat != null && cfg.long != null; else noPin">
                <span class="coords">Pinned: {{ cfg.lat }}, {{ cfg.long }}</span>
                <a [href]="'https://www.google.com/maps?q=' + cfg.lat + ',' + cfg.long" target="_blank" rel="noopener">
                    <clr-icon shape="pop-out"></clr-icon> Open in Google Maps
                </a>
                <button type="button" class="button-small" *ngIf="!readonly" (click)="clearPin()">Clear pin</button>
            </div>
            <ng-template #noPin><div class="error">No pin yet — Adloggs needs the store’s exact location.</div></ng-template>

            <div class="row-2">
                <label class="field-label">Pickup Contact Name
                    <input type="text" class="field-input" placeholder="Ramu" [disabled]="readonly" [value]="cfg.name"
                        (input)="update({ name: $any($event.target).value })" />
                </label>
                <label class="field-label">Pickup Contact Phone
                    <input type="text" class="field-input" placeholder="9500303975" inputmode="numeric" [disabled]="readonly" [value]="cfg.phone"
                        (input)="update({ phone: $any($event.target).value })" />
                </label>
            </div>
            <label class="field-label">Pickup Address (given to the rider)
                <textarea class="field-input field-textarea" placeholder="Gandhipuram, Coimbatore, Tamil Nadu, India" [disabled]="readonly"
                    [value]="cfg.address" (input)="update({ address: $any($event.target).value })"></textarea>
            </label>
            <div class="row-3">
                <label class="field-label">Pincode <span class="auto">(auto-filled from the pin)</span>
                    <input type="text" class="field-input" [disabled]="readonly" [value]="cfg.pincode" (input)="update({ pincode: $any($event.target).value })" />
                </label>
                <label class="field-label">City <span class="auto">(auto-filled)</span>
                    <input type="text" class="field-input" [disabled]="readonly" [value]="cfg.city" (input)="update({ city: $any($event.target).value })" />
                </label>
                <label class="field-label">State <span class="auto">(auto-filled)</span>
                    <input type="text" class="field-input" [disabled]="readonly" [value]="cfg.state" (input)="update({ state: $any($event.target).value })" />
                </label>
            </div>
        </div>
    `,
    styles: [
        `
            .pickup-input { display: flex; flex-direction: column; gap: 8px; max-width: 720px; }
            .toolbar { display: flex; gap: 8px; align-items: center; }
            .pincode-input { width: 160px; padding: 4px 8px; border: 1px solid var(--color-component-border-100, #d1d5db); border-radius: 3px; }
            .zone-label { font-size: 13px; color: var(--color-text-200, #374151); }
            .hint { font-size: 12px; color: var(--color-text-300, #6b7280); }
            .error { color: var(--color-error-500, #dc2626); font-size: 12px; }
            .map-canvas { width: 100%; height: 320px; border-radius: 4px; }
            .map-canvas.hidden { display: none; }
            .coords-row { display: flex; align-items: center; gap: 16px; font-size: 13px; }
            .coords { color: var(--color-text-300, #6b7280); }
            .row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
            .row-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
            .field-label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--color-text-200, #374151); }
            .auto { font-weight: 400; color: var(--color-text-300, #6b7280); }
            .field-input { width: 100%; padding: 6px 8px; border: 1px solid var(--color-component-border-100, #d1d5db); border-radius: 3px; font-size: 13px; font-weight: 400; box-sizing: border-box; }
            .field-textarea { min-height: 56px; resize: vertical; }
        `,
    ],
})
export class AdloggsPickupConfigInputComponent implements FormInputComponent, OnInit, OnDestroy {
    readonly = false;
    formControl!: FormControl;
    config: any;

    @ViewChild('mapContainer', { static: true }) mapContainer!: ElementRef<HTMLDivElement>;

    cfg: PickupConfig = { ...EMPTY };
    interactive = false;
    locating = false;
    errorMsg = '';
    zoneLabel = '';
    embedUrl: SafeResourceUrl | null = null;

    private map: any;
    private marker: any;
    private keySub?: Subscription;
    private mapInitStarted = false;

    static readonly id = 'adloggs-pickup-config-input';

    constructor(
        private dataService: DataService,
        private sanitizer: DomSanitizer,
        private zone: NgZone,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit() {
        this.cfg = this.parse(this.formControl?.value);
        this.updateEmbed();
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
    }

    private parse(value: unknown): PickupConfig {
        if (!value) {
            return { ...EMPTY };
        }
        try {
            const v = typeof value === 'string' ? JSON.parse(value) : value;
            return {
                ...EMPTY,
                ...v,
                lat: v.lat != null && v.lat !== '' ? Number(v.lat) : null,
                long: v.long != null && v.long !== '' ? Number(v.long) : null,
            };
        } catch {
            return { ...EMPTY };
        }
    }

    /** Single write path: update local state and emit the JSON to the form control. */
    update(patch: Partial<PickupConfig>) {
        this.cfg = { ...this.cfg, ...patch };
        this.formControl.setValue(JSON.stringify(this.cfg));
        this.formControl.markAsDirty();
        this.cdr.markForCheck();
    }

    private async initMap(apiKey: string) {
        if (this.mapInitStarted) {
            return;
        }
        this.mapInitStarted = true;
        window.gm_authFailure = () => {
            this.zone.run(() => {
                this.interactive = false;
                this.errorMsg =
                    'Google Maps rejected the API key. In Google Cloud check: Maps JavaScript API is enabled, billing is active, and the key’s website restrictions include this URL.';
                this.updateEmbed();
                this.cdr.markForCheck();
            });
        };
        try {
            const maps = await loadGoogleMaps(apiKey);
            this.interactive = true;
            const hasPin = this.cfg.lat != null && this.cfg.long != null;
            const center = hasPin ? { lat: this.cfg.lat!, lng: this.cfg.long! } : { lat: 10.5, lng: 78.2 };
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
                this.map.addListener('click', (e: any) => this.zone.run(() => this.setPin(e.latLng.lat(), e.latLng.lng())));
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
        this.marker = new maps.Marker({ position, map: this.map, draggable: !this.readonly });
        this.marker.addListener('dragend', (e: any) => this.zone.run(() => this.setPin(e.latLng.lat(), e.latLng.lng())));
    }

    setPin(lat: number, lng: number, opts?: { zoom?: number; embedQuery?: string; resolved?: ResolvedPlace }) {
        const round = (n: number) => Math.round(n * 1e6) / 1e6;
        lat = round(lat);
        lng = round(lng);
        this.errorMsg = '';
        this.update({ lat, long: lng });
        if (this.interactive && window.google?.maps) {
            this.placeMarker(window.google.maps, { lat, lng });
            this.map?.panTo({ lat, lng });
            if (opts?.zoom) {
                this.map?.setZoom(opts.zoom);
            }
        }
        this.updateEmbed(opts?.embedQuery, opts?.zoom);
        if (opts?.resolved) {
            this.applyResolved(opts.resolved);
        } else {
            void this.reverseGeocode(lat, lng);
        }
    }

    /** Pin → auto-fill pincode/city/state (+ address when empty). */
    private applyResolved(place: ResolvedPlace) {
        this.zoneLabel = place.address;
        this.update({
            pincode: place.pincode || this.cfg.pincode,
            city: place.city || this.cfg.city,
            state: place.state || this.cfg.state,
            address: this.cfg.address.trim() ? this.cfg.address : place.address,
        });
    }

    private async reverseGeocode(lat: number, lng: number) {
        try {
            if (window.google?.maps) {
                const geocoder = new window.google.maps.Geocoder();
                const { results } = await geocoder.geocode({ location: { lat, lng } });
                if (results?.[0]) {
                    this.zone.run(() => this.applyResolved(fromGoogleResult(results[0])));
                    return;
                }
            }
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2`, {
                headers: { Accept: 'application/json' },
            });
            const data = await res.json();
            if (data?.address) {
                this.zone.run(() => this.applyResolved(fromNominatimResult(data)));
            }
        } catch (e: any) {
            if (String(e?.message ?? e).includes('REQUEST_DENIED')) {
                this.errorMsg = 'Address lookup failed: enable the Geocoding API for this key in Google Cloud.';
                this.cdr.markForCheck();
            }
        }
    }

    clearPin() {
        this.update({ lat: null, long: null });
        this.marker?.setMap(null);
        this.marker = undefined;
        this.zoneLabel = '';
        this.updateEmbed();
    }

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
                const { results } = await geocoder.geocode({ componentRestrictions: { postalCode: pincode, country: 'IN' } });
                const best = results?.[0];
                if (!best) {
                    throw new Error('not found');
                }
                const loc = best.geometry.location;
                this.setPin(loc.lat(), loc.lng(), { embedQuery: pincode, resolved: fromGoogleResult(best) });
                if (best.geometry.viewport) {
                    this.map?.fitBounds(best.geometry.viewport);
                }
            } else {
                let best = await this.nominatim(`postalcode=${pincode}&countrycodes=in`);
                if (!best) {
                    best = await this.nominatim(`q=${encodeURIComponent(pincode + ', India')}&countrycodes=in`);
                }
                if (!best) {
                    throw new Error('not found');
                }
                const resolved = fromNominatimResult(best);
                this.setPin(parseFloat(best.lat), parseFloat(best.lon), {
                    zoom: 13,
                    embedQuery: pincode,
                    resolved: { ...resolved, pincode: resolved.pincode || pincode },
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
        const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}&format=jsonv2&addressdetails=1&limit=1`, {
            headers: { Accept: 'application/json' },
        });
        const data = await res.json();
        return data?.[0];
    }

    useGps() {
        this.errorMsg = '';
        if (!window.isSecureContext) {
            this.errorMsg = 'GPS only works over HTTPS or on localhost. Open the admin via http://localhost, or use pincode.';
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
            pos => this.zone.run(() => {
                this.locating = false;
                this.setPin(pos.coords.latitude, pos.coords.longitude, { zoom: 17 });
            }),
            err => this.zone.run(() => {
                this.locating = false;
                this.errorMsg =
                    err.code === err.PERMISSION_DENIED
                        ? 'Location permission denied — allow it in the browser, or use pincode instead.'
                        : 'Could not get GPS position — use pincode instead.';
                this.cdr.markForCheck();
            }),
            { enableHighAccuracy: true, timeout: 15000 },
        );
    }

    private updateEmbed(query?: string, zoom?: number) {
        const q = query
            ? `${encodeURIComponent(query)},India`
            : this.cfg.lat != null && this.cfg.long != null
              ? `${this.cfg.lat},${this.cfg.long}`
              : 'Tamil+Nadu,India';
        const z = zoom ?? (query ? 12 : this.cfg.lat != null ? 16 : 7);
        this.embedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(`https://maps.google.com/maps?q=${q}&z=${z}&output=embed`);
    }
}

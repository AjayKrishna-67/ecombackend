import { useQuery } from '@tanstack/react-query';
import { api, graphql, Button, Input } from '@vendure/dashboard';
import { ExternalLink, LocateFixed, MapPin, Search, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { getBridgeField, subscribeBridge } from './field-bridge';
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

const googleMapsApiKeyDocument = graphql(`
    query GoogleMapsApiKey {
        googleMapsApiKey
    }
`);

declare const window: any;

/** Loads the Google Maps JS API once per dashboard session. */
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
 * React-dashboard Store Location picker, rendered INSIDE the Calculator card
 * as the take-away calculator's `storeLocation` arg component. The arg holds
 * no data — everything is written to the ShippingMethod custom fields through
 * the field bridge (their hidden rows register their form controllers there),
 * which marks the form dirty so the Create/Update button activates.
 */
export function StoreLocationArg(props: any) {
    const { disabled } = props;
    // Re-render whenever the hidden custom-field rows (bridge) update.
    const [, setBridgeTick] = useState(0);
    useEffect(() => subscribeBridge(() => setBridgeTick(t => t + 1)), []);

    const latField = getBridgeField('storeLatitude');
    const lngField = getBridgeField('storeLongitude');
    const addressField = getBridgeField('storeAddress');
    const couponField = getBridgeField('takeAwayCouponCode');
    const phonesField = getBridgeField('notificationPhones');
    const notifyTemplateField = getBridgeField('notificationWhatsappTemplate');
    const pickupSlotField = getBridgeField('pickupSlot');

    // Pickup Time dropdowns: the parts are the editor's working state (seeded
    // from the stored window once), and every change writes `{ from, to }`
    // text through the bridged `pickupSlot` field for the server to validate.
    const [timeParts, setTimeParts] = useState<{ from: TimeParts; to: TimeParts } | null>(null);
    const storedSlot = pickupSlotField?.value ?? {};
    const parts = timeParts ?? { from: splitPickupTime(storedSlot.from), to: splitPickupTime(storedSlot.to) };
    const pickupFrom = joinPickupTime(parts.from);
    const pickupTo = joinPickupTime(parts.to);
    const pickupWindowError = pickupWindowMessage(pickupFrom, pickupTo);
    const writeTimeParts = (next: { from: TimeParts; to: TimeParts }) => {
        setTimeParts(next);
        // A half-set end is written as null so the server's own message
        // ("set both ends") appears on save if the admin leaves it that way.
        pickupSlotField?.onChange({ from: joinPickupTime(next.from), to: joinPickupTime(next.to) });
    };
    const onTimePart = (end: 'from' | 'to', part: keyof TimeParts, value: string) =>
        writeTimeParts({ ...parts, [end]: { ...parts[end], [part]: value } });
    const clearPickupTime = () => writeTimeParts({ from: { ...EMPTY_PARTS }, to: { ...EMPTY_PARTS } });

    // Local mirrors: the hidden bridge fields may not re-render on every
    // form update, so typed text / fresh pins are shown from local state
    // while every change is still written through the bridge controllers.
    const [localPin, setLocalPin] = useState<{ lat: number | null; lng: number | null } | null>(null);
    const [localAddress, setLocalAddress] = useState<string | null>(null);
    const [localCoupon, setLocalCoupon] = useState<string | null>(null);
    const [localPhones, setLocalPhones] = useState<string | null>(null);
    const [localNotifyTemplate, setLocalNotifyTemplate] = useState<string | null>(null);

    const bridgeLat = typeof latField?.value === 'number' ? latField.value : null;
    const bridgeLng = typeof lngField?.value === 'number' ? lngField.value : null;
    const lat: number | null = localPin !== null ? localPin.lat : bridgeLat;
    const lng: number | null = localPin !== null ? localPin.lng : bridgeLng;
    const address: string = localAddress !== null ? localAddress : (addressField?.value ?? '');
    const coupon: string = localCoupon !== null ? localCoupon : (couponField?.value ?? '');
    const phones: string = localPhones !== null ? localPhones : (phonesField?.value ?? '');
    const notifyTemplate: string =
        localNotifyTemplate !== null ? localNotifyTemplate : (notifyTemplateField?.value ?? '');

    const [pincode, setPincode] = useState('');
    const [zoneLabel, setZoneLabel] = useState('');
    const [errorMsg, setErrorMsg] = useState('');
    const [locating, setLocating] = useState(false);
    const [interactive, setInteractive] = useState(false);
    const [embed, setEmbed] = useState<{ q: string; z: number } | null>(null);

    const mapDivRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<any>(null);
    const markerRef = useRef<any>(null);
    const setPinRef = useRef<(lat: number, lng: number, opts?: any) => void>(() => undefined);

    const { data: keyData } = useQuery({
        queryKey: ['take-away-google-maps-api-key'],
        queryFn: () => api.query(googleMapsApiKeyDocument),
    });
    const apiKey: string = (keyData as any)?.googleMapsApiKey ?? '';

    const setField = (
        key: 'lat' | 'lng' | 'address' | 'coupon' | 'phones' | 'notifyTemplate',
        value: any,
    ) => {
        const entry =
            key === 'lat'
                ? latField
                : key === 'lng'
                  ? lngField
                  : key === 'address'
                    ? addressField
                    : key === 'coupon'
                      ? couponField
                      : key === 'phones'
                        ? phonesField
                        : notifyTemplateField;
        entry?.onChange(value);
    };

    const placeMarker = (maps: any, position: { lat: number; lng: number }) => {
        if (markerRef.current) {
            markerRef.current.setPosition(position);
            return;
        }
        markerRef.current = new maps.Marker({
            position,
            map: mapRef.current,
            draggable: !disabled,
        });
        markerRef.current.addListener('dragend', (e: any) =>
            setPinRef.current(e.latLng.lat(), e.latLng.lng()),
        );
    };

    const applyResolvedAddress = (resolved: string) => {
        // Display only — the admin types the Store Address themselves
        // (auto-filling it was explicitly not wanted).
        setZoneLabel(resolved);
    };

    const reverseGeocode = async (rgLat: number, rgLng: number) => {
        try {
            const geocoder = new window.google.maps.Geocoder();
            const { results } = await geocoder.geocode({ location: { lat: rgLat, lng: rgLng } });
            const resolved = results?.[0]?.formatted_address;
            if (resolved) {
                applyResolvedAddress(resolved);
            }
        } catch (e: any) {
            // Address lookup is best-effort; the pin itself is already set.
            if (String(e?.message ?? e).includes('REQUEST_DENIED')) {
                setErrorMsg('Address lookup failed: enable the Geocoding API for this key in Google Cloud.');
            }
        }
    };

    const setPin = (
        newLat: number,
        newLng: number,
        opts?: { zoneLabel?: string; zoom?: number; embedQuery?: string },
    ) => {
        const round = (n: number) => Math.round(n * 1e6) / 1e6;
        newLat = round(newLat);
        newLng = round(newLng);
        setErrorMsg('');
        setZoneLabel(opts?.zoneLabel ?? '');
        setLocalPin({ lat: newLat, lng: newLng });
        setField('lat', newLat);
        setField('lng', newLng);
        if (mapRef.current && window.google?.maps) {
            placeMarker(window.google.maps, { lat: newLat, lng: newLng });
            mapRef.current.panTo({ lat: newLat, lng: newLng });
            if (opts?.zoom) {
                mapRef.current.setZoom(opts.zoom);
            }
        }
        setEmbed({
            q: opts?.embedQuery ? `${encodeURIComponent(opts.embedQuery)},India` : `${newLat},${newLng}`,
            z: opts?.zoom ?? (opts?.embedQuery ? 12 : 16),
        });
        // Direct pin (map click, drag, GPS): look up the address for it.
        if (!opts?.zoneLabel && window.google?.maps) {
            void reverseGeocode(newLat, newLng);
        }
    };
    setPinRef.current = setPin;

    // Initial embed for keyless mode: current pin or a south-India overview.
    useEffect(() => {
        setEmbed(prev => prev ?? (lat != null && lng != null ? { q: `${lat},${lng}`, z: 16 } : { q: 'Tamil+Nadu,India', z: 7 }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Interactive map when the API key is available.
    useEffect(() => {
        if (!apiKey || mapRef.current) {
            return;
        }
        let cancelled = false;
        // Google reports invalid keys / blocked referrers via this global
        // callback AFTER the script loads.
        window.gm_authFailure = () => {
            setInteractive(false);
            setErrorMsg(
                'Google Maps rejected the API key. In Google Cloud check: Maps JavaScript API is enabled, billing is active, and the key’s website restrictions include this URL (e.g. http://localhost:5173/*).',
            );
        };
        loadGoogleMaps(apiKey)
            .then(maps => {
                if (cancelled || !mapDivRef.current) {
                    return;
                }
                const hasPin = lat != null && lng != null;
                const center = hasPin ? { lat: lat!, lng: lng! } : { lat: 10.5, lng: 78.2 };
                mapRef.current = new maps.Map(mapDivRef.current, {
                    center,
                    zoom: hasPin ? 16 : 7,
                    streetViewControl: false,
                    mapTypeControl: false,
                });
                if (hasPin) {
                    placeMarker(maps, center);
                }
                if (!disabled) {
                    mapRef.current.addListener('click', (e: any) =>
                        setPinRef.current(e.latLng.lat(), e.latLng.lng()),
                    );
                }
                setInteractive(true);
            })
            .catch(() => setInteractive(false));
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiKey]);

    const locatePincode = async () => {
        const pc = pincode.trim();
        setErrorMsg('');
        if (!/^\d{6}$/.test(pc)) {
            setErrorMsg('Enter a valid 6-digit pincode.');
            return;
        }
        setLocating(true);
        try {
            if (interactive && window.google?.maps) {
                const geocoder = new window.google.maps.Geocoder();
                const { results } = await geocoder.geocode({
                    componentRestrictions: { postalCode: pc, country: 'IN' },
                });
                const best = results?.[0];
                if (!best) throw new Error('not found');
                const loc = best.geometry.location;
                setPin(loc.lat(), loc.lng(), { zoneLabel: best.formatted_address, embedQuery: pc });
                applyResolvedAddress(best.formatted_address);
                if (best.geometry.viewport) {
                    mapRef.current?.fitBounds(best.geometry.viewport);
                }
            } else {
                // Nominatim: postalcode search first, free-text as fallback.
                const nominatim = async (params: string) => {
                    const res = await fetch(
                        `https://nominatim.openstreetmap.org/search?${params}&format=jsonv2&limit=1`,
                        { headers: { Accept: 'application/json' } },
                    );
                    const data = await res.json();
                    return data?.[0];
                };
                const best =
                    (await nominatim(`postalcode=${pc}&countrycodes=in`)) ??
                    (await nominatim(`q=${encodeURIComponent(pc + ', India')}&countrycodes=in`));
                if (!best) throw new Error('not found');
                setPin(parseFloat(best.lat), parseFloat(best.lon), {
                    zoneLabel: best.display_name,
                    zoom: 13,
                    embedQuery: pc,
                });
            }
        } catch (e: any) {
            setErrorMsg(
                `Could not locate pincode ${pc}${e?.message === 'not found' ? '' : ` (${e?.message})`}. Check the pincode or try GPS.`,
            );
        } finally {
            setLocating(false);
        }
    };

    const useGps = () => {
        setErrorMsg('');
        if (!window.isSecureContext) {
            setErrorMsg(
                'GPS only works over HTTPS or on localhost. Open the dashboard via http://localhost instead of the IP address, or use pincode.',
            );
            return;
        }
        if (!navigator.geolocation) {
            setErrorMsg('This browser does not support geolocation.');
            return;
        }
        setLocating(true);
        navigator.geolocation.getCurrentPosition(
            pos => {
                setLocating(false);
                setPin(pos.coords.latitude, pos.coords.longitude, {
                    zoneLabel: 'Pinned from GPS.',
                    zoom: 17,
                });
            },
            err => {
                setLocating(false);
                setErrorMsg(
                    err.code === err.PERMISSION_DENIED
                        ? 'Location permission denied — allow it in the browser, or use pincode instead.'
                        : 'Could not get GPS position — use pincode instead.',
                );
            },
            { enableHighAccuracy: true, timeout: 15000 },
        );
    };

    const clearPin = () => {
        setLocalPin({ lat: null, lng: null });
        setField('lat', null);
        setField('lng', null);
        markerRef.current?.setMap(null);
        markerRef.current = null;
        setZoneLabel('');
        setEmbed({ q: 'Tamil+Nadu,India', z: 7 });
    };

    if (!latField || !lngField) {
        return <div className="text-sm text-muted-foreground">Loading store location fields…</div>;
    }

    return (
        <div className="flex flex-col gap-2 max-w-2xl">
            <div className="flex items-center gap-2">
                <Input
                    className="w-40"
                    placeholder="Pincode e.g. 625001"
                    maxLength={6}
                    value={pincode}
                    disabled={disabled || locating}
                    onChange={e => setPincode(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            void locatePincode();
                        }
                    }}
                />
                <Button type="button" variant="secondary" size="sm" disabled={disabled || locating}
                    onClick={() => void locatePincode()}>
                    <Search className="h-4 w-4 mr-1" /> Locate pincode
                </Button>
                <Button type="button" variant="secondary" size="sm" disabled={disabled || locating} onClick={useGps}>
                    <LocateFixed className="h-4 w-4 mr-1" /> Use GPS
                </Button>
            </div>
            {zoneLabel ? (
                <div className="flex items-center gap-1 text-sm text-foreground">
                    <MapPin className="h-4 w-4" /> {zoneLabel}
                </div>
            ) : null}
            {interactive && !disabled ? (
                <div className="text-xs text-muted-foreground">
                    Click anywhere on the map to pin the store; drag the marker to adjust.
                </div>
            ) : null}
            {errorMsg ? <div className="text-sm text-destructive">{errorMsg}</div> : null}

            <div ref={mapDivRef} className={interactive ? 'w-full h-80 rounded-md' : 'hidden'} />
            {!interactive && embed ? (
                <iframe
                    title="Store location map"
                    src={`https://maps.google.com/maps?q=${embed.q}&z=${embed.z}&output=embed`}
                    className="w-full rounded-md border-0"
                    height={320}
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                />
            ) : null}

            {lat != null && lng != null ? (
                <div className="flex items-center gap-4 text-sm">
                    <span className="text-muted-foreground">
                        Pinned: {lat}, {lng}
                    </span>
                    <a
                        href={`https://www.google.com/maps?q=${lat},${lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-primary hover:underline"
                    >
                        <ExternalLink className="h-4 w-4" /> Open in Google Maps
                    </a>
                    {!disabled ? (
                        <Button type="button" variant="ghost" size="sm" onClick={clearPin}>
                            <X className="h-4 w-4 mr-1" /> Clear pin
                        </Button>
                    ) : null}
                </div>
            ) : null}

            <label className="flex flex-col gap-1.5 text-sm font-medium">
                Store Address (shown to the customer)
                <textarea
                    className="border-input flex min-h-14 w-full rounded-md border bg-transparent px-3 py-2 text-sm font-normal shadow-sm"
                    value={address}
                    disabled={disabled}
                    onChange={e => {
                        setLocalAddress(e.target.value);
                        setField('address', e.target.value);
                    }}
                />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
                Take Away Coupon Code (optional — must equal this method's promotion coupon code)
                <Input
                    value={coupon}
                    disabled={disabled}
                    onChange={e => {
                        setLocalCoupon(e.target.value);
                        setField('coupon', e.target.value);
                    }}
                />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
                Order Notification Numbers (comma-separated — each gets a WhatsApp alert on new orders)
                <Input
                    value={phones}
                    placeholder="9840012345, 9840067890"
                    disabled={disabled}
                    onChange={e => {
                        setLocalPhones(e.target.value);
                        setField('phones', e.target.value);
                    }}
                />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
                Notification WhatsApp Template (approved MSG91 template for the staff alert)
                <Input
                    value={notifyTemplate}
                    placeholder="new_order_alert"
                    disabled={disabled}
                    onChange={e => {
                        setLocalNotifyTemplate(e.target.value);
                        setField('notifyTemplate', e.target.value);
                    }}
                />
            </label>
            {pickupSlotField ? (
                <div className="flex flex-col gap-1.5 text-sm font-medium">
                    Pickup Time (shown to the customer — the same window every day)
                    {(['from', 'to'] as const).map(end => (
                        <div key={end} className="flex flex-wrap items-center gap-2 font-normal">
                            <span className="w-10 text-sm">{end === 'from' ? 'From' : 'To'}</span>
                            <TimeSelect
                                value={parts[end].hour}
                                options={HOURS}
                                placeholder="Hour"
                                disabled={disabled}
                                onChange={v => onTimePart(end, 'hour', v)}
                            />
                            <TimeSelect
                                value={parts[end].minute}
                                options={MINUTES}
                                placeholder="Min"
                                disabled={disabled}
                                onChange={v => onTimePart(end, 'minute', v)}
                            />
                            <TimeSelect
                                value={parts[end].meridiem}
                                options={MERIDIEMS}
                                placeholder="AM/PM"
                                disabled={disabled}
                                onChange={v => onTimePart(end, 'meridiem', v)}
                            />
                        </div>
                    ))}
                    <div className="flex flex-wrap items-center gap-3 font-normal">
                        {pickupFrom && pickupTo && !pickupWindowError ? (
                            <span className="text-xs text-muted-foreground">
                                Customers see: {pickupFrom} - {pickupTo}
                            </span>
                        ) : null}
                        {pickupWindowError ? <span className="text-xs text-destructive">{pickupWindowError}</span> : null}
                        {!disabled && (parts.from.hour || parts.to.hour) ? (
                            <Button type="button" variant="ghost" size="sm" onClick={clearPickupTime}>
                                <X className="h-4 w-4 mr-1" /> Clear
                            </Button>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function TimeSelect({
    value,
    options,
    placeholder,
    disabled,
    onChange,
}: Readonly<{
    value: string;
    options: string[];
    placeholder: string;
    disabled?: boolean;
    onChange: (value: string) => void;
}>) {
    return (
        <select
            className="border-input h-9 min-w-[90px] flex-1 basis-[90px] max-w-[140px] rounded-md border bg-transparent px-2 text-sm shadow-sm"
            value={value}
            disabled={disabled}
            onChange={e => onChange(e.target.value)}
        >
            <option value="">{placeholder}</option>
            {options.map(o => (
                <option key={o} value={o}>
                    {o}
                </option>
            ))}
        </select>
    );
}

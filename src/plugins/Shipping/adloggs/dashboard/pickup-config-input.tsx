import { useQuery } from '@tanstack/react-query';
import { api, graphql, Button, DashboardFormComponent, Input } from '@vendure/dashboard';
import { ExternalLink, LocateFixed, MapPin, Search, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';

const googleMapsApiKeyDocument = graphql(`
    query AdloggsGoogleMapsApiKey {
        googleMapsApiKey
    }
`);

declare const window: any;

/** Loads the Google Maps JS API once per dashboard session (shared loader key with take-away). */
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

const EMPTY: PickupConfig = { name: '', phone: '', address: '', lat: null, long: null, pincode: '', city: '', state: '' };

function parseConfig(value: unknown): PickupConfig {
    if (!value) {
        return EMPTY;
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
        return EMPTY;
    }
}

/** What a reverse-geocode resolves for a pin. */
interface ResolvedPlace {
    address: string;
    pincode: string;
    city: string;
    state: string;
}

/** Google Geocoder result → the fields Adloggs needs. */
function fromGoogleResult(result: any): ResolvedPlace {
    const comps: any[] = result?.address_components ?? [];
    const pick = (...types: string[]) =>
        comps.find(c => types.some(t => c.types?.includes(t)))?.long_name ?? '';
    return {
        address: result?.formatted_address ?? '',
        pincode: pick('postal_code'),
        city: pick('locality', 'administrative_area_level_3', 'administrative_area_level_2'),
        state: pick('administrative_area_level_1'),
    };
}

/** Nominatim reverse result → the fields Adloggs needs (keyless fallback). */
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
 * component. Pin the store on the map (click/drag with a Google key; pincode
 * search or GPS otherwise); every pin reverse-geocodes and auto-fills
 * latitude/longitude, pincode, city, state (and the address when empty).
 * The admin types the contact name and phone below the map; everything is
 * stored as one JSON string in the arg.
 */
export const AdloggsPickupConfigInput: DashboardFormComponent = ({ value, onChange, disabled }: any) => {
    const initial = useMemo(() => parseConfig(value), []); // eslint-disable-line react-hooks/exhaustive-deps
    const [cfg, setCfg] = useState<PickupConfig>(initial);
    const cfgRef = useRef(cfg);
    cfgRef.current = cfg;

    const [pincodeQuery, setPincodeQuery] = useState('');
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

    /** Single write path: update local state and emit the JSON to the form. */
    const update = (patch: Partial<PickupConfig>) => {
        const next = { ...cfgRef.current, ...patch };
        cfgRef.current = next;
        setCfg(next);
        onChange?.(JSON.stringify(next));
    };

    const placeMarker = (maps: any, position: { lat: number; lng: number }) => {
        if (markerRef.current) {
            markerRef.current.setPosition(position);
            return;
        }
        markerRef.current = new maps.Marker({ position, map: mapRef.current, draggable: !disabled });
        markerRef.current.addListener('dragend', (e: any) => setPinRef.current(e.latLng.lat(), e.latLng.lng()));
    };

    /** Pin → auto-fill pincode/city/state (+ address when empty). */
    const applyResolved = (place: ResolvedPlace) => {
        setZoneLabel(place.address);
        const current = cfgRef.current;
        update({
            pincode: place.pincode || current.pincode,
            city: place.city || current.city,
            state: place.state || current.state,
            address: current.address.trim() ? current.address : place.address,
        });
    };

    const reverseGeocode = async (rgLat: number, rgLng: number) => {
        try {
            if (window.google?.maps) {
                const geocoder = new window.google.maps.Geocoder();
                const { results } = await geocoder.geocode({ location: { lat: rgLat, lng: rgLng } });
                if (results?.[0]) {
                    applyResolved(fromGoogleResult(results[0]));
                    return;
                }
            }
            const res = await fetch(
                `https://nominatim.openstreetmap.org/reverse?lat=${rgLat}&lon=${rgLng}&format=jsonv2`,
                { headers: { Accept: 'application/json' } },
            );
            const data = await res.json();
            if (data?.address) {
                applyResolved(fromNominatimResult(data));
            }
        } catch (e: any) {
            if (String(e?.message ?? e).includes('REQUEST_DENIED')) {
                setErrorMsg('Address lookup failed: enable the Geocoding API for this key in Google Cloud.');
            }
        }
    };

    const setPin = (newLat: number, newLng: number, opts?: { zoom?: number; embedQuery?: string; resolved?: ResolvedPlace }) => {
        const round = (n: number) => Math.round(n * 1e6) / 1e6;
        newLat = round(newLat);
        newLng = round(newLng);
        setErrorMsg('');
        update({ lat: newLat, long: newLng });
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
        if (opts?.resolved) {
            applyResolved(opts.resolved);
        } else {
            void reverseGeocode(newLat, newLng);
        }
    };
    setPinRef.current = setPin;

    useEffect(() => {
        setEmbed(prev =>
            prev ?? (cfg.lat != null && cfg.long != null ? { q: `${cfg.lat},${cfg.long}`, z: 16 } : { q: 'Tamil+Nadu,India', z: 7 }),
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!apiKey || mapRef.current) {
            return;
        }
        let cancelled = false;
        window.gm_authFailure = () => {
            setInteractive(false);
            setErrorMsg(
                'Google Maps rejected the API key. In Google Cloud check: Maps JavaScript API is enabled, billing is active, and the key’s website restrictions include this URL.',
            );
        };
        loadGoogleMaps(apiKey)
            .then(maps => {
                if (cancelled || !mapDivRef.current) {
                    return;
                }
                const c = cfgRef.current;
                const hasPin = c.lat != null && c.long != null;
                const center = hasPin ? { lat: c.lat!, lng: c.long! } : { lat: 10.5, lng: 78.2 };
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
                    mapRef.current.addListener('click', (e: any) => setPinRef.current(e.latLng.lat(), e.latLng.lng()));
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
        const pc = pincodeQuery.trim();
        setErrorMsg('');
        if (!/^\d{6}$/.test(pc)) {
            setErrorMsg('Enter a valid 6-digit pincode.');
            return;
        }
        setLocating(true);
        try {
            if (interactive && window.google?.maps) {
                const geocoder = new window.google.maps.Geocoder();
                const { results } = await geocoder.geocode({ componentRestrictions: { postalCode: pc, country: 'IN' } });
                const best = results?.[0];
                if (!best) throw new Error('not found');
                const loc = best.geometry.location;
                setPin(loc.lat(), loc.lng(), { embedQuery: pc, resolved: fromGoogleResult(best) });
                if (best.geometry.viewport) {
                    mapRef.current?.fitBounds(best.geometry.viewport);
                }
            } else {
                const nominatim = async (params: string) => {
                    const res = await fetch(
                        `https://nominatim.openstreetmap.org/search?${params}&format=jsonv2&addressdetails=1&limit=1`,
                        { headers: { Accept: 'application/json' } },
                    );
                    const data = await res.json();
                    return data?.[0];
                };
                const best =
                    (await nominatim(`postalcode=${pc}&countrycodes=in`)) ??
                    (await nominatim(`q=${encodeURIComponent(pc + ', India')}&countrycodes=in`));
                if (!best) throw new Error('not found');
                const resolved = fromNominatimResult(best);
                setPin(parseFloat(best.lat), parseFloat(best.lon), {
                    zoom: 13,
                    embedQuery: pc,
                    resolved: { ...resolved, pincode: resolved.pincode || pc },
                });
            }
        } catch (e: any) {
            setErrorMsg(`Could not locate pincode ${pc}${e?.message === 'not found' ? '' : ` (${e?.message})`}. Check the pincode or try GPS.`);
        } finally {
            setLocating(false);
        }
    };

    const useGps = () => {
        setErrorMsg('');
        if (!window.isSecureContext) {
            setErrorMsg('GPS only works over HTTPS or on localhost. Open the dashboard via http://localhost, or use pincode.');
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
                setPin(pos.coords.latitude, pos.coords.longitude, { zoom: 17 });
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
        update({ lat: null, long: null });
        markerRef.current?.setMap(null);
        markerRef.current = null;
        setZoneLabel('');
        setEmbed({ q: 'Tamil+Nadu,India', z: 7 });
    };

    const inputClass =
        'border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm font-normal shadow-sm disabled:opacity-50';

    return (
        <div className="flex flex-col gap-2 max-w-2xl">
            <div className="flex items-center gap-2">
                <Input
                    className="w-40"
                    placeholder="Pincode e.g. 641012"
                    maxLength={6}
                    value={pincodeQuery}
                    disabled={disabled || locating}
                    onChange={e => setPincodeQuery(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            void locatePincode();
                        }
                    }}
                />
                <Button type="button" variant="secondary" size="sm" disabled={disabled || locating} onClick={() => void locatePincode()}>
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
                    Click anywhere on the map to pin the store; drag the marker to adjust. Pincode, city and state fill in
                    automatically.
                </div>
            ) : null}
            {errorMsg ? <div className="text-sm text-destructive">{errorMsg}</div> : null}

            <div ref={mapDivRef} className={interactive ? 'w-full h-80 rounded-md' : 'hidden'} />
            {!interactive && embed ? (
                <iframe
                    title="Pickup store map"
                    src={`https://maps.google.com/maps?q=${embed.q}&z=${embed.z}&output=embed`}
                    className="w-full rounded-md border-0"
                    height={320}
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                />
            ) : null}

            {cfg.lat != null && cfg.long != null ? (
                <div className="flex items-center gap-4 text-sm">
                    <span className="text-muted-foreground">
                        Pinned: {cfg.lat}, {cfg.long}
                    </span>
                    <a
                        href={`https://www.google.com/maps?q=${cfg.lat},${cfg.long}`}
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
            ) : (
                <div className="text-sm text-destructive">No pin yet — Adloggs needs the store’s exact location.</div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                    Pickup Contact Name
                    <Input value={cfg.name} disabled={disabled} placeholder="Ramu" onChange={e => update({ name: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                    Pickup Contact Phone
                    <Input
                        value={cfg.phone}
                        disabled={disabled}
                        placeholder="9500303975"
                        inputMode="numeric"
                        onChange={e => update({ phone: e.target.value })}
                    />
                </label>
            </div>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
                Pickup Address (given to the rider)
                <textarea
                    className="border-input flex min-h-14 w-full rounded-md border bg-transparent px-3 py-2 text-sm font-normal shadow-sm"
                    value={cfg.address}
                    disabled={disabled}
                    placeholder="Gandhipuram, Coimbatore, Tamil Nadu, India"
                    onChange={e => update({ address: e.target.value })}
                />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                    Pincode <span className="text-xs font-normal text-muted-foreground">(auto-filled from the pin)</span>
                    <input className={inputClass} value={cfg.pincode} disabled={disabled} onChange={e => update({ pincode: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                    City <span className="text-xs font-normal text-muted-foreground">(auto-filled)</span>
                    <input className={inputClass} value={cfg.city} disabled={disabled} onChange={e => update({ city: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                    State <span className="text-xs font-normal text-muted-foreground">(auto-filled)</span>
                    <input className={inputClass} value={cfg.state} disabled={disabled} onChange={e => update({ state: e.target.value })} />
                </label>
            </div>
        </div>
    );
};

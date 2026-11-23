import { Order } from '@vendure/core';
import { randomInt } from 'crypto';

import { ADLOGGS_STATUS_RANK, AdloggsCreateOrderRequest, AdloggsPickupConfig, AdloggsStatus } from '../types';

/** India offset (minutes) — the only market Adloggs serves for us. */
export const IST_UTC_OFFSET_MINUTES = 330;

/** How long after "now" the pickup should be collected by. */
export const PICKUP_BUFFER_MINUTES = 15;

/**
 * Keep the last 10 digits: strips +91 / 91 prefixes, spaces and punctuation.
 * Adloggs expects a plain 10-digit Indian mobile number.
 */
export function normalizePhone(raw: string | null | undefined): string {
    const digits = (raw ?? '').replace(/\D/g, '');
    return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Paise → "1234.50" rupee string (Adloggs wants decimal strings). */
export function paiseToRupeeString(paise: number): string {
    return (paise / 100).toFixed(2);
}

/**
 * "YYYY-MM-DD HH:mm" in the utc_offset timezone, bufferMinutes from `now`.
 * Pure so the format is testable without freezing global time.
 */
export function formatPickupDateTime(
    now: Date,
    offsetMinutes: number = IST_UTC_OFFSET_MINUTES,
    bufferMinutes: number = PICKUP_BUFFER_MINUTES,
): string {
    const local = new Date(now.getTime() + (offsetMinutes + bufferMinutes) * 60_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return (
        `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
        ` ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
    );
}

/**
 * Normalize Vendure ConfigurableOperation args to a plain record. Live
 * calculator calls receive a typed object; args read back from a stored
 * shipping method arrive as [{ name, value }] with string values (and
 * sometimes as a JSON string) — accept all three shapes.
 */
export function argsToRecord(args: unknown): Record<string, any> {
    let value: any = args;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return {};
        }
    }
    if (Array.isArray(value)) {
        const record: Record<string, any> = {};
        for (const entry of value) {
            if (entry && typeof entry.name === 'string') {
                record[entry.name] = entry.value;
            }
        }
        return record;
    }
    return value && typeof value === 'object' ? value : {};
}

/** Keys of the JSON written by the pickup-config UI component (map picker). */
const PICKUP_JSON_KEYS = ['name', 'phone', 'address', 'lat', 'long', 'pincode', 'city', 'state'] as const;

/**
 * Read the pickup (store) details from the Adloggs calculator's arguments
 * (configured on the shipping method). The calculator has one `pickupConfig`
 * arg holding a JSON object written by the map-picker UI component
 * ({ name, phone, address, lat, long, pincode, city, state }); flat
 * `pickupName`/`pickupLat`/... keys are accepted too. Returns null with the
 * missing field names when the method is not fully set up.
 */
export function pickupConfigFromArgs(args: unknown): { config: AdloggsPickupConfig | null; missing: string[] } {
    const record = argsToRecord(args);
    let json: any = record.pickupConfig;
    if (typeof json === 'string') {
        try {
            json = JSON.parse(json);
        } catch {
            json = undefined;
        }
    }
    const flat: Record<string, any> = json && typeof json === 'object' ? {} : { ...record };
    if (json && typeof json === 'object') {
        for (const key of PICKUP_JSON_KEYS) {
            flat[`pickup${key.charAt(0).toUpperCase()}${key.slice(1)}`] = json[key];
        }
    }
    const missing: string[] = [];
    const require = (field: string, value: unknown) => {
        if (value === null || value === undefined || value === '') {
            missing.push(field);
        }
    };
    require('pickupName', flat.pickupName);
    require('pickupPhone', flat.pickupPhone);
    require('pickupAddress', flat.pickupAddress);
    require('pickupLat', flat.pickupLat);
    require('pickupLong', flat.pickupLong);
    require('pickupPincode', flat.pickupPincode);
    require('pickupCity', flat.pickupCity);
    require('pickupState', flat.pickupState);
    if (missing.length > 0) {
        return { config: null, missing };
    }
    return {
        config: {
            name: String(flat.pickupName),
            phone: String(flat.pickupPhone),
            address: String(flat.pickupAddress),
            lat: Number(flat.pickupLat),
            long: Number(flat.pickupLong),
            pincode: String(flat.pickupPincode),
            city: String(flat.pickupCity),
            state: String(flat.pickupState),
        },
        missing,
    };
}

export interface BuildPayloadInput {
    order: Order;
    pickup: AdloggsPickupConfig;
    /** Customer coordinates (map pin, or pincode approximation). */
    delivery: { lat: number; long: number };
    /** Total order weight in kg (already resolved from variant measures). */
    weightKg: number;
    now: Date;
    /** 4-digit delivery OTP to send (see generateDeliveryOtp). */
    deliveryOtp?: number;
}

/**
 * A 4-digit delivery OTP for a new Adloggs order. We choose it and send it on
 * create, so we always know it: Adloggs returns it only in status webhooks,
 * never from getcurrentstatus (the manual Sync path). 1000-9999 so it never
 * starts with 0 (the API types it as an integer).
 */
export function generateDeliveryOtp(): number {
    return randomInt(1000, 10000);
}

/**
 * Map a Vendure order to the Adloggs v2 create-order request.
 *
 * Money: Vendure stores paise; Adloggs wants rupee decimal strings.
 *
 * Always prepaid: the Adloggs account is not enabled for COD ("COD orders not
 * allowed"), and KaaiKani collects cash itself anyway — the rider never handles
 * money, so payment_type is "Online" with collectible_amount 0 regardless of
 * how the customer paid.
 */
export function buildAdloggsCreatePayload(input: BuildPayloadInput): AdloggsCreateOrderRequest {
    const { order, pickup, delivery, weightKg, now, deliveryOtp } = input;
    const shippingAddress = order.shippingAddress!;
    const customer = order.customer;

    const deliveryName =
        shippingAddress.fullName || [customer?.firstName, customer?.lastName].filter(Boolean).join(' ') || 'Customer';
    const deliveryPhone = normalizePhone(shippingAddress.phoneNumber || customer?.phoneNumber);
    const deliveryAddressText = [
        shippingAddress.streetLine1,
        shippingAddress.streetLine2,
        shippingAddress.city,
        shippingAddress.province,
    ]
        .filter(Boolean)
        .join(', ')
        .slice(0, 500);

    return {
        partner_order_id: order.code,
        pickup_contact_name: pickup.name,
        pickup_contact_no: normalizePhone(pickup.phone),
        pickup_address: pickup.address.slice(0, 500),
        pickup_address_details: {
            city_name: pickup.city,
            state_name: pickup.state,
            country_name: 'India',
            pincode: pickup.pincode,
        },
        pickup_date_time: formatPickupDateTime(now),
        pickup_lat: pickup.lat,
        pickup_long: pickup.long,
        delivery_contact_name: deliveryName,
        delivery_contact_no: deliveryPhone,
        delivery_address: deliveryAddressText,
        delivery_address_details: {
            street_name: shippingAddress.streetLine1 || undefined,
            city_name: shippingAddress.city || pickup.city,
            state_name: shippingAddress.province || pickup.state,
            country_name: 'India',
            pincode: shippingAddress.postalCode || pickup.pincode,
        },
        delivery_lat: delivery.lat,
        delivery_long: delivery.long,
        ...(deliveryOtp != null ? { delivery_otp: deliveryOtp } : {}),
        order_category: 'Grocery',
        order_total_price: paiseToRupeeString(order.totalWithTax),
        order_total_weight_in_kg: weightKg.toFixed(2),
        items: order.lines.map(line => ({
            name: line.productVariant.name,
            quantity: String(line.quantity),
            price: paiseToRupeeString(line.unitPriceWithTax * line.quantity),
        })),
        order_description: `KaaiKani order ${order.code}`,
        utc_offset: IST_UTC_OFFSET_MINUTES,
        payment_type: 'Online',
        collectible_amount: 0,
    };
}

/** Rank of each Vendure fulfillment state on the delivery ladder. */
const STATE_RANK: Record<string, number> = {
    Created: 0,
    Pending: 0,
    Shipped: 1,
    OutforDelivery: 2,
    Delivered: 3,
};

/** The Vendure state each Adloggs status implies (null = no state change). */
const TARGET_STATE: Record<number, string | null> = {
    [AdloggsStatus.Pending]: null,
    [AdloggsStatus.Assigned]: null,
    [AdloggsStatus.ArrivedAtPickup]: null,
    [AdloggsStatus.PickedUp]: 'Shipped',
    [AdloggsStatus.OutForDelivery]: 'OutforDelivery',
    [AdloggsStatus.ArrivedAtDelivery]: 'OutforDelivery',
    [AdloggsStatus.Delivered]: 'Delivered',
    [AdloggsStatus.Cancelled]: 'Cancelled',
    // Return flows have no clean Vendure equivalent — surfaced to the admin
    // via adloggsStatus + a warning log, resolved manually.
    [AdloggsStatus.ReturnInitiated]: null,
    [AdloggsStatus.RtoDelivered]: null,
};

/**
 * The chain of fulfillment transitions needed to reflect an Adloggs status.
 *
 * The fulfillment process here is Pending → Shipped → OutforDelivery → Delivered
 * (OutforDelivery comes from the delivery-strategy-router process; Shipped →
 * Delivered directly is still legal, so a Delivered webhook arriving while the
 * fulfillment is Pending yields ['Shipped', 'Delivered']).
 *
 * Cancellation: only legal from Pending/Shipped (the custom OutforDelivery state
 * only transitions to Delivered) — later cancels return [] and are left to the
 * admin to resolve manually.
 */
export function transitionChain(currentState: string, adloggsStatusId: number): string[] {
    const target = TARGET_STATE[adloggsStatusId] ?? null;
    if (!target) {
        return [];
    }
    if (target === 'Cancelled') {
        return STATE_RANK[currentState] <= 1 ? ['Cancelled'] : [];
    }
    const currentRank = STATE_RANK[currentState];
    const targetRank = STATE_RANK[target];
    if (currentRank === undefined || currentRank >= targetRank) {
        return [];
    }
    const chain: string[] = [];
    if (currentRank < 1 && targetRank >= 1) {
        chain.push('Shipped');
    }
    if (currentRank < 2 && targetRank === 2) {
        chain.push('OutforDelivery');
    }
    if (targetRank === 3) {
        // Shipped → Delivered is legal; skip OutforDelivery unless already there.
        chain.push('Delivered');
    }
    return chain;
}

/**
 * True when `incomingStatusId` is older than the status already stored —
 * i.e. applying it would move the delivery backwards. Equal rank is NOT
 * stale (a redelivered webhook is a harmless no-op). Unknown ids are never
 * treated as stale so a new Adloggs status can still be recorded.
 */
export function isStaleStatus(storedStatusId: number | null | undefined, incomingStatusId: number): boolean {
    if (storedStatusId == null) {
        return false;
    }
    const stored = ADLOGGS_STATUS_RANK[storedStatusId];
    const incoming = ADLOGGS_STATUS_RANK[incomingStatusId];
    if (stored === undefined || incoming === undefined) {
        return false;
    }
    return incoming < stored;
}

/** Great-circle distance in km between two coordinates. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/**
 * Of several candidate pickup stores, the one closest to the delivery pin.
 * Falls back to the first candidate when the delivery pin is unknown.
 */
export function nearestPickup<T extends { config: AdloggsPickupConfig }>(
    candidates: T[],
    deliveryLat: number | null | undefined,
    deliveryLong: number | null | undefined,
): T | undefined {
    if (candidates.length === 0) {
        return undefined;
    }
    if (deliveryLat == null || deliveryLong == null || Number.isNaN(Number(deliveryLat)) || Number.isNaN(Number(deliveryLong))) {
        return candidates[0];
    }
    let best = candidates[0];
    let bestKm = Infinity;
    for (const c of candidates) {
        const km = haversineKm(Number(deliveryLat), Number(deliveryLong), c.config.lat, c.config.long);
        if (km < bestKm) {
            bestKm = km;
            best = c;
        }
    }
    return best;
}

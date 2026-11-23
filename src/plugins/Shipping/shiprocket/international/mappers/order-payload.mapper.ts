import {
    DEFAULT_COMMODITY,
    DEFAULT_IGST_PAYMENT_STATUS,
    DEFAULT_MIES,
    DEFAULT_ORDER_TYPE,
    DEFAULT_REASON_OF_EXPORT,
    DEFAULT_TERMS_OF_INVOICE,
    PAYMENT_METHOD_PREPAID,
    PURPOSE_OF_SHIPMENT,
} from '../constants';
import { isdCodeForCountry } from '../data/isd-codes';
import { ShiprocketAdhocOrderItem, ShiprocketAdhocOrderPayload } from '../types';

/**
 * Pure mapping of a Vendure order (already reduced to primitive fields) into the Shiprocket
 * `create/adhoc` payload. No IO and no Vendure-entity coupling, so it is unit-tested in
 * `order-payload.mapper.spec.ts`. The IO/extraction lives in the fulfillment handler + service.
 */
export interface AdhocMapperInput {
    /**
     * Sent as `order_id`/`channel_order_id`. A fresh random 10-digit number per creation attempt
     * (Shiprocket keeps cancelled orders, so re-fulfilment must send a new id). The handler stores
     * it on the fulfillment (`shiprocketChannelOrderId`) so the admin block can display it.
     */
    orderCode: string;
    /** Sent as `order_date` — order placement time (SR shows it as "Order created on channel"). */
    orderDate: Date;
    /** Order currency, e.g. "USD". */
    currencyCode: string;
    /** Sent as `invoice_number` — the Vendure order code, tying the SR invoice to the order. */
    invoiceNumber: string;
    /** Shiprocket pickup-location nickname (config.pickupLocationName). */
    pickupLocationName: string;

    // Destination (shipping address)
    fullName: string;
    streetLine1: string;
    streetLine2: string;
    city: string;
    /** State, e.g. "New York" — sourced from Vendure's `shippingAddress.province` field. */
    state: string;
    postalCode: string;
    /** Full country name, e.g. "Singapore". */
    countryName: string;
    /** ISO alpha-2, e.g. "SG" — used to derive billing_isd_code. */
    countryCode: string;
    email: string;
    /** Local phone digits (no country code); ISD is derived from countryCode. */
    phone: string;

    // Items (prices in the order currency's MAJOR units, e.g. 1.35)
    items: Array<{ name: string; sku: string; units: number; sellingPrice: number; hsn: string }>;

    // Shipment
    /** Shipping charge in the order currency's major units. */
    shippingChargesMajor: number;
    /** Box dimensions in cm and total weight in kg (from the weight→box bracket). */
    length: number;
    breadth: number;
    height: number;
    weightKg: number;

    /** Optional per-channel ISD overrides for edge cases. */
    isdOverrides?: Record<string, string>;
}

/**
 * Reduces a stored phone number to the local digits Shiprocket wants in `billing_phone` (the ISD
 * goes in `billing_isd_code` separately). Strips all non-digits, and if the storefront happened to
 * prepend the country's calling code, removes it — but only when a plausible local number (≥7
 * digits) remains, so legitimate digits are never eaten.
 */
export function sanitizePhone(
    raw: string | undefined | null,
    countryCode: string,
    overrides?: Record<string, string>,
): string {
    let digits = (raw ?? '').replace(/\D/g, '');
    const isd = (isdCodeForCountry(countryCode, overrides) ?? '').replace(/\D/g, '');
    if (isd && digits.startsWith(isd) && digits.length - isd.length >= 7) {
        digits = digits.slice(isd.length);
    }
    return digits;
}

/** Splits a full name into first + last (first token vs the remainder). */
export function splitName(fullName: string): { first: string; last: string } {
    const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
        return { first: '', last: '' };
    }
    return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** Formats a date as Shiprocket expects: `YYYY-MM-DD HH:mm`. */
export function formatShiprocketDate(date: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return (
        `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
        `${p(date.getHours())}:${p(date.getMinutes())}`
    );
}

/** Rounds to 2 decimals (currency major units) without floating-point noise. */
function money(n: number): number {
    return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Returns the reasons this order cannot be sent to Shiprocket yet, empty if it is ready. The live
 * API silently creates an *incomplete* order otherwise (its "Customer phone is empty" /
 * "Delivery pincode is empty" errors), so we gate on these first for a clear admin message.
 */
export function validateAdhocInput(input: AdhocMapperInput): string[] {
    const problems: string[] = [];
    if (!input.pickupLocationName?.trim()) {
        problems.push('Pickup location name is not configured (Settings → Shiprocket International).');
    }
    if (!input.phone?.trim()) {
        problems.push('Customer phone number is empty.');
    }
    if (!input.postalCode?.trim()) {
        problems.push('Delivery postal code is empty.');
    }
    if (!input.state?.trim()) {
        // Confirmed against the live API: create/adhoc 422s with "The billing state field is
        // required" when this is blank.
        problems.push('Delivery state is empty (Shiprocket requires billing_state).');
    }
    if (!input.countryCode?.trim()) {
        problems.push('Delivery country is missing.');
    }
    if (!input.items.length) {
        problems.push('Order has no line items.');
    }
    if (!(input.weightKg > 0)) {
        problems.push('Total shipment weight is 0 (product options missing a g/kg Measure Value).');
    }
    return problems;
}

/** Builds the `create/adhoc` payload. Call `validateAdhocInput` first for a clean failure. */
export function buildAdhocPayload(input: AdhocMapperInput): ShiprocketAdhocOrderPayload {
    const { first, last } = splitName(input.fullName);
    // Couriers read/print Address Line 1 first, so the storefront's Door No (streetLine1) and
    // street (streetLine2) are sent together in billing_address; billing_address_2 stays empty.
    const addressLine1 = [input.streetLine1, input.streetLine2]
        .map(s => (s ?? '').trim())
        .filter(Boolean)
        .join(', ');
    const order_items: ShiprocketAdhocOrderItem[] = input.items.map(i => ({
        name: i.name,
        sku: i.sku,
        units: i.units,
        selling_price: money(i.sellingPrice),
        hsn: i.hsn ?? '',
    }));
    const sub_total = money(
        input.items.reduce((sum, i) => sum + (Number(i.sellingPrice) || 0) * (Number(i.units) || 0), 0),
    );

    return {
        order_id: input.orderCode,
        order_date: formatShiprocketDate(input.orderDate),
        pickup_location: input.pickupLocationName,
        billing_customer_name: first,
        billing_last_name: last,
        billing_address: addressLine1,
        billing_address_2: '',
        billing_city: input.city ?? '',
        billing_pincode: input.postalCode ?? '',
        billing_state: input.state ?? '',
        billing_country: input.countryName ?? '',
        billing_email: input.email ?? '',
        billing_phone: input.phone ?? '',
        billing_isd_code: isdCodeForCountry(input.countryCode, input.isdOverrides) ?? '',
        shipping_is_billing: true,
        order_items,
        payment_method: PAYMENT_METHOD_PREPAID,
        shipping_charges: money(input.shippingChargesMajor),
        sub_total,
        length: input.length,
        breadth: input.breadth,
        height: input.height,
        weight: input.weightKg,
        invoice_number: input.invoiceNumber ?? '',
        purpose_of_shipment: PURPOSE_OF_SHIPMENT,
        currency: input.currencyCode,
        reasonOfExport: DEFAULT_REASON_OF_EXPORT,
        commodity: DEFAULT_COMMODITY,
        mies: DEFAULT_MIES,
        igstPaymentStatus: DEFAULT_IGST_PAYMENT_STATUS,
        Terms_Of_Invoice: DEFAULT_TERMS_OF_INVOICE,
        order_type: DEFAULT_ORDER_TYPE,
    };
}

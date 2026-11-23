// ---------------------------------------------------------------------------------------------
// Plugin config (persisted in the SettingsStore, edited in the dashboard settings page)
// ---------------------------------------------------------------------------------------------

/**
 * One row of the editable weight → box-dimension table. A cart whose total weight is
 * `<= maxGrams` (and greater than the previous row's maxGrams) uses these L/B/H values.
 * Dimensions are centimetres, as required by the Shiprocket serviceability API.
 */
export interface BoxBracket {
    /** Upper bound of this weight bracket, in grams (inclusive). */
    maxGrams: number;
    /** Length in cm. */
    length: number;
    /** Breadth in cm. */
    breadth: number;
    /** Height in cm. */
    height: number;
}

/**
 * Channel-scoped Shiprocket configuration. Per-courier pricing (provider, per-gram slab,
 * static charge, tariff toggle) lives on each ShippingMethod's calculator args instead —
 * this object holds only the account/box settings shared across all Shiprocket methods.
 */
export interface ShiprocketConfig {
    /** Origin pincode shipments are dispatched from (Shiprocket `pickup_postcode`). */
    pickupPincode: string;
    /**
     * Shiprocket pickup-location **nickname** (not the pincode) used by the order-create API's
     * `pickup_location` field, e.g. "warehouse". Must match a pickup address saved in Shiprocket.
     */
    pickupLocationName: string;
    /**
     * INR per 1 USD. Final charge = totalINR / fxRate, then ×100 for minor units.
     * Use 1 to treat the courier rate as already in the order currency.
     */
    fxRate: number;
    /** Editable weight → L/B/H table. Evaluated smallest-maxGrams-first. */
    boxBrackets: BoxBracket[];
}

// ---------------------------------------------------------------------------------------------
// Shiprocket REST API response shapes (only the fields we consume are typed strongly)
// ---------------------------------------------------------------------------------------------

export interface ShiprocketRate {
    rate: number;
    /** Present for some couriers (e.g. India Post); used as a fallback when `rate` is non-positive. */
    total?: number;
    zone?: string;
    /** Estimated delivery window in days, e.g. `{ edd: { from: 10, to: 12 } }`. */
    extra_info?: {
        edd?: { from?: number; to?: number };
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface ShiprocketExtraCharge {
    name: string;
    value: string;
}

export interface ShiprocketCourier {
    courier_company_id: number;
    courier_name: string;
    is_international: number;
    /** Estimated delivery window, e.g. "Jul 07, 2026 - Jul 14, 2026". */
    etd: string;
    /** e.g. "8 - 15". */
    estimated_delivery_days: string;
    rate: ShiprocketRate;
    extra_charges: ShiprocketExtraCharge[];
    /** Map of HSN code → tariff percentage, e.g. { "61091000": 15 }. */
    tariff: Record<string, number>;
    [key: string]: unknown;
}

export interface ShiprocketServiceabilityResponse {
    currency: string;
    data: {
        recommended_courier_company_id: number | null;
        available_courier_companies: ShiprocketCourier[];
        [key: string]: unknown;
    };
    status: number;
}

/** Inputs the serviceability call needs, resolved from the order + channel config. */
export interface ServiceabilityQuery {
    pickupPincode: string;
    deliveryCountry: string;
    weightKg: number;
    length: number;
    breadth: number;
    height: number;
    hsnCodes: string;
    cod: 0 | 1;
}

// ---------------------------------------------------------------------------------------------
// Order creation (fulfillment) — international/orders/create/adhoc
// ---------------------------------------------------------------------------------------------

/** One line item in the adhoc order-create payload. */
export interface ShiprocketAdhocOrderItem {
    name: string;
    sku: string;
    units: number;
    /** Per-unit price in the order currency's **major** units (e.g. 1.35). */
    selling_price: number;
    hsn: string;
}

/**
 * Payload for `international/orders/create/adhoc`. Built purely from a Vendure Order + channel
 * config by `mappers/order-payload.mapper.ts` (unit-tested, no IO). `billing_isd_code` is derived
 * from the destination country; `pickup_location` is the configured pickup nickname.
 */
export interface ShiprocketAdhocOrderPayload {
    order_id: string;
    order_date: string;
    pickup_location: string;
    billing_customer_name: string;
    billing_last_name: string;
    billing_address: string;
    billing_address_2: string;
    billing_city: string;
    billing_pincode: string;
    billing_state: string;
    billing_country: string;
    billing_email: string;
    billing_phone: string;
    billing_isd_code: string;
    shipping_is_billing: boolean;
    order_items: ShiprocketAdhocOrderItem[];
    payment_method: string;
    shipping_charges: number;
    sub_total: number;
    length: number;
    breadth: number;
    height: number;
    /** Total shipment weight in kg. */
    weight: number;
    invoice_number: string;
    purpose_of_shipment: number;
    currency: string;
    reasonOfExport: number;
    commodity: string;
    mies: string;
    igstPaymentStatus: string;
    Terms_Of_Invoice: string;
    order_type: string;
}

/** Response from `international/orders/create/adhoc`. */
export interface ShiprocketCreateOrderResponse {
    order_id: number;
    channel_order_id: string;
    shipment_id: number;
    status: string;
    status_code: number;
    awb_code: string;
    courier_company_id: string | number;
    courier_name: string;
    packaging_box_error?: string;
    [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------------
// Order details — orders/show/{id} (only the fields we surface in the dashboard)
// ---------------------------------------------------------------------------------------------

export interface ShiprocketOrderDetailsResponse {
    data: {
        id: number;
        status: string;
        status_code: number;
        is_incomplete?: number;
        errors?: Record<string, string>;
        shipments?: {
            id: number;
            awb?: string | null;
            courier?: string;
            courier_id?: string | number;
            status?: string;
            weight?: number;
            volumetric_weight?: number;
            dimensions?: string;
            length?: number;
            breadth?: number;
            height?: number;
            invoice_link?: string;
            etd?: string;
        };
        [key: string]: unknown;
    };
}

// ---------------------------------------------------------------------------------------------
// Tracking — courier/track/awb/{awb}
// ---------------------------------------------------------------------------------------------

export interface ShiprocketTrackActivity {
    date: string;
    status: string;
    activity: string;
    location: string;
    'sr-status'?: string | number;
    'sr-status-label'?: string;
}

export interface ShiprocketTrackingResponse {
    tracking_data: {
        track_status: number;
        shipment_status: number;
        shipment_track?: Array<{
            awb_code?: string;
            courier_name?: string;
            current_status?: string;
            edd?: string;
            destination?: string;
            origin?: string;
            [key: string]: unknown;
        }>;
        shipment_track_activities?: ShiprocketTrackActivity[];
        track_url?: string;
        etd?: string;
        [key: string]: unknown;
    };
}

/** Normalised tracking shape returned by our GraphQL API (admin + shop). */
export interface ShiprocketTracking {
    awb: string;
    courierName: string | null;
    currentStatus: string | null;
    etd: string | null;
    trackUrl: string | null;
    activities: Array<{
        date: string;
        status: string;
        activity: string;
        location: string;
        srStatus: string | null;
        srStatusLabel: string | null;
    }>;
}

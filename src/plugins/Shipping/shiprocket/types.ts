// Types for the Shiprocket shipping-rate plugin.
// Shapes derived from how services/ship-rocket.ts consumes them and the
// Shiprocket serviceability API response.

export interface PluginInitOptions {
    email?: string;
    password?: string;
}

export interface RateCalculatorParams {
    pickup_postcode: string;
    delivery_postcode: string;
    weight_in_kg: number;
    order_value: number;
    is_cod: boolean;
}

export interface CourierRate {
    courier_company_id: number;
    courier_name: string;
    rate: number;
    blocked: number;
    estimated_delivery_days: string;
    etd: string;
    realtime_tracking: string;
    cod: number;
    [key: string]: unknown;
}

export interface RateApiResponse {
    status: number;
    data?: {
        available_courier_companies?: CourierRate[];
    };
}

// Shape returned by the shop-api getShippingOptions query.
export interface ShippingOption {
    id: string;
    name: string;
    description: string;
    price: number;
    estimatedDeliveryDays: string;
    courierName: string;
    etd: string;
    trackingAvailable: boolean;
    codAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Shiprocket Quick (hyperlocal) types
// ---------------------------------------------------------------------------

export interface PickupAddress {
    id: number;
    pickup_location: string;
    address_type: string | null;
    address: string;
    address_2: string;
    city: string;
    state: string;
    country: string;
    pin_code: string;
    phone: string;
    name: string;
    lat: string;
    long: string;
    is_primary_location: number;
    status: number;
}

export interface PickupAddressResponse {
    data: {
        shipping_address: PickupAddress[];
        allow_more: string;
        is_blackbox_seller: boolean;
        company_name: string;
        recent_addresses: unknown[];
    };
}

export interface QuickRateParams {
    pickup_postcode: number;
    delivery_postcode: number;
    cod: number;
    is_new_hyperlocal: number;
    lat_from: number;
    long_from: number;
    lat_to: number;
    long_to: number;
}

export interface QuickRate {
    courier_name: string;
    rates: number;
    rto_rates: number;
    etd: string;
    etd_hours: number;
    distance: number;
}

export interface QuickRateResponse {
    status: boolean;
    data: QuickRate[];
}

export interface CreateQuickOrderInput {
    order_id: string;
    order_date: string;
    channel_id?: number; // Optional - can be omitted for Quick orders
    pickup_location: string;
    category?: string;
    billing_customer_name: string;
    billing_last_name: string;
    billing_phone: string;
    billing_address: string;
    billing_address_2?: string;
    billing_city: string;
    billing_pincode: number;
    billing_state: string;
    billing_country: string;
    billing_email?: string;
    shipping_is_billing: boolean;
    latitude: number;
    longitude: number;
    order_items: Array<{
        name: string;
        sku: string;
        units: number;
        selling_price: number;
    }>;
    payment_method: string;
    sub_total: number;
    length: number;
    breadth: number;
    height: number;
    weight: number;
    shipping_method: string; // "HL" for hyperlocal
}

export interface QuickOrderResponse {
    order_id: number;
    channel_order_id: string;
    shipment_id: number;
    status: string;
    status_code: number;
    onboarding_completed_now: number;
    awb_code: string;
    courier_company_id: string;
    courier_name: string;
    new_channel: boolean;
    packaging_box_error: string;
}

export interface CancelOrderResponse {
    status_code: number;
    message: string;
}

export interface ShiprocketOrderDetails {
    id: number;
    channel_order_id: string;
    status: string;
    status_code: number;
    customer_name: string;
    customer_email: string;
    customer_phone: string;
    customer_address: string;
    customer_address_2: string;
    customer_city: string;
    customer_state: string;
    customer_pincode: string;
    customer_country: string;
    pickup_location: string;
    pickup_location_id: number;
    payment_method: string;
    total: number;
    net_total: string;
    cod: number;
    created_at: string;
    updated_at: string;
    order_date: string;
    shipments: {
        id: number;
        awb: string | null;
        courier: string;
        courier_id: string;
        status: string;
        etd: string;
        delivered_date: string;
        weight: number;
        dimensions: string;
        length: number;
        breadth: number;
        height: number;
    };
    products: Array<{
        id: number;
        name: string;
        sku: string;
        quantity: number;
        price: number;
        selling_price: number;
    }>;
    pickup_address: {
        id: number;
        pickup_code: string;
        name: string;
        phone: string;
        address: string;
        address_2: string;
        city: string;
        state: string;
        country: string;
        lat: string;
        long: string;
    };
}

export interface OrderDetailsResponse {
    data: ShiprocketOrderDetails;
}

// Tracking by shipment id (GET /courier/track/shipment/{shipment_id}) —
// works for Quick from the moment the order exists, even before the rider
// is assigned and the AWB generated.
export interface QuickShipmentTrack {
    id: number;
    awb_code: string;
    courier_name: string;
    current_status: string;
    origin: string;
    destination: string;
    pickup_date: string | null;
    delivered_date: string | null;
    edd: string | null;
    [key: string]: unknown;
}

export interface QuickTrackActivity {
    date: string;
    status: string;
    activity: string;
    location: string;
    'sr-status'?: string | number;
    'sr-status-label'?: string;
}

export interface QuickTrackingData {
    track_status: number;
    shipment_status: number;
    shipment_track: QuickShipmentTrack[];
    shipment_track_activities: QuickTrackActivity[] | null;
    track_url: string;
    etd?: string;
    /** Present when Shiprocket has nothing to track (e.g. "Ohh! This AWB has been cancelled."). */
    error?: string;
}

/**
 * Live-verified response shape: track/shipment/{id} wraps the payload under the
 * shipment id key — `{ "<shipmentId>": { "tracking_data": { ... } } }` — unlike
 * track/awb/{awb}, which returns `{ "tracking_data": { ... } }` directly.
 */
export type QuickTrackingResponse = Record<string, { tracking_data: QuickTrackingData }>;

export interface AssignAwbResponse {
    success: boolean;
    message: string;
}

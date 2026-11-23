export interface PluginInitOptions {
    /** https://dev.adloggs.com (dev) or https://app.adloggs.com (live) */
    apiHost: string;
    /** x-api-key issued by Adloggs */
    apiKey: string;
    /**
     * Shared secret Adloggs sends back in the x-webhook-token header of every
     * status webhook. We generate it and hand it to the Adloggs team together
     * with the webhook URL. Empty string disables the webhook endpoint.
     */
    webhookToken: string;
}

/**
 * Adloggs order_status_id values (from the API doc "ORDER STATUSES").
 */
export enum AdloggsStatus {
    Pending = 2,
    Assigned = 3,
    ArrivedAtPickup = 11,
    PickedUp = 4,
    OutForDelivery = 9,
    ArrivedAtDelivery = 8,
    Delivered = 5,
    Cancelled = 6,
    ReturnInitiated = 13,
    RtoDelivered = 14,
}

/** Human-readable labels for the status ids (UI + logs). */
export const ADLOGGS_STATUS_LABELS: Record<number, string> = {
    2: 'Pending',
    3: 'Assigned',
    11: 'Arrived at pickup',
    4: 'Picked up',
    9: 'Out for delivery',
    8: 'Arrived at delivery',
    5: 'Delivered',
    6: 'Cancelled',
    13: 'Return initiated',
    14: 'RTO delivered',
};

/**
 * Progress rank of each status. Webhooks can arrive out of order (a late
 * "Picked up" after "Delivered"); an update whose rank is lower than the
 * stored status is ignored so the order never appears to walk backwards.
 * Delivered and Cancelled share a rank (both terminal outcomes of a delivery);
 * return flows rank above them because they happen after a delivery attempt.
 */
export const ADLOGGS_STATUS_RANK: Record<number, number> = {
    2: 0, 3: 1, 11: 2, 4: 3, 9: 4, 8: 5, 5: 6, 6: 6, 13: 7, 14: 8,
};

/** Standard Adloggs response envelope. */
export interface AdloggsEnvelope<T = any> {
    status: boolean;
    code: number;
    message: string;
    data: T;
    err?: string;
}

export interface AdloggsAddressDetails {
    door_no?: string;
    street_name?: string;
    city_name: string;
    district_name?: string;
    state_name: string;
    country_name: string;
    pincode: string;
}

export interface AdloggsOrderItem {
    name: string;
    quantity: string;
    /** Item price * quantity, as decimal string */
    price: string;
}

/** POST /aa/oporder/v2/create */
export interface AdloggsCreateOrderRequest {
    partner_order_id: string;
    pickup_contact_name: string;
    pickup_contact_no: string;
    pickup_address: string;
    pickup_address_details: AdloggsAddressDetails;
    pickup_date_time: string; // YYYY-MM-DD HH:mm (local to utc_offset)
    pickup_lat: number;
    pickup_long: number;
    delivery_contact_name: string;
    delivery_contact_no: string;
    delivery_address: string;
    delivery_address_details: AdloggsAddressDetails;
    delivery_lat: number;
    delivery_long: number;
    /** 4-digit OTP the rider checks with the customer at the door (optional in the API). */
    delivery_otp?: number;
    order_category: 'Food and Beverage' | 'Grocery';
    order_total_price: string;
    order_total_weight_in_kg: string;
    items: AdloggsOrderItem[];
    order_description?: string;
    utc_offset: number;
    payment_type: 'Online' | 'COD';
    collectible_amount: number;
}

export interface AdloggsCreateOrderResponseData {
    order_uuid: string;
    trackUrl: string;
    partner_order_id: string;
    partner_merchant_id?: string;
    fee: number;
    distance: number;
    meta_data?: string;
}

/** POST /aa/oporder/v1.2/service/availability */
export interface AdloggsAvailabilityRequest {
    partner_order_id: string;
    pickup_lat: number;
    pickup_long: number;
    pickup_pincode: string;
    delivery_lat: number;
    delivery_long: number;
    delivery_pincode: string;
    utc_offset: number;
    payment_type: 'Online' | 'COD';
}

export interface AdloggsAvailabilityResponseData {
    service_available?: boolean;
    service_availability?: boolean; // unserviceable response uses this key
    to_pickup?: { eta_min: number };
    distance?: number;
    estimated_price?: number;
    code?: string;
}

/** POST /aa/oporder/getcurrentstatus */
export interface AdloggsCurrentStatusData {
    order_uuid: string;
    order_status_id: number;
    is_return: boolean;
    deliveryStaffDetails?: AdloggsRiderDetails;
}

export interface AdloggsRiderDetails {
    name?: string;
    phone?: string;
    currentLocation?: { lat?: string; long?: string };
}

/** Webhook body Adloggs POSTs to us on every status change. */
export interface AdloggsWebhookPayload {
    order_uuid: string;
    order_status_id: number;
    partner_order_id: string;
    deliveryStaffDetails?: AdloggsRiderDetails;
    eta?: { to_pickup?: number; to_delivery?: number };
    rider_platform?: { name?: string; lsp_uniq_id?: string };
    reason?: string | null;
    otps?: { delivery_otp?: string | null; pickup_otp?: string | null; return_otp?: string | null };
}

/** Pickup details read from the order channel's custom fields. */
export interface AdloggsPickupConfig {
    name: string;
    phone: string;
    address: string;
    lat: number;
    long: number;
    pincode: string;
    city: string;
    state: string;
}

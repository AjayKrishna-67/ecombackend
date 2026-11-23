import { ShiprocketConfig } from './types';

/** Logger context for all Shiprocket-international log output. */
export const loggerCtx = 'ShiprocketInternationalPlugin';

/**
 * SettingsStore key. The whole plugin config (pickup pincode, FX, box brackets, …) is stored
 * as one channel-scoped JSON object under this key. Read/written via the generic
 * getSettingsStoreValue / setSettingsStoreValue GraphQL API from the dashboard settings page.
 */
export const SHIPROCKET_CONFIG_KEY = 'shiprocket.config';

// --- Shiprocket REST API ------------------------------------------------------------------

export const SHIPROCKET_API_BASE = 'https://apiv2.shiprocket.in/v1/external';
// Auth lives in the shared ShipRocket service (../services/ship-rocket) — one
// cached login is reused by both the Quick and International integrations.
export const SHIPROCKET_SERVICEABILITY_PATH = '/international/courier/serviceability';
/** Order creation (fulfillment). */
export const SHIPROCKET_CREATE_ADHOC_PATH = '/international/orders/create/adhoc';
/** Order details, append the Shiprocket order id: `/orders/show/{id}`. */
export const SHIPROCKET_ORDER_SHOW_PATH = '/orders/show/';
/** Tracking, append the AWB: `/courier/track/awb/{awb}`. */
export const SHIPROCKET_TRACK_AWB_PATH = '/courier/track/awb/';
/** Order cancellation: POST `{ ids: [<shiprocket order id>] }`. */
export const SHIPROCKET_ORDER_CANCEL_PATH = '/orders/cancel';

// --- Caching (Vendure CacheService) -------------------------------------------------------

/** Serviceability responses are cached briefly to avoid hammering the API on every recalc. */
export const SERVICEABILITY_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** Tracking responses are cached briefly so a busy tracking page doesn't hit the rate limit. */
export const TRACKING_TTL_MS = 3 * 60 * 1000; // 3 minutes

// Hard-coded serviceability params (not admin-editable).
/** `purpose_of_shipment` — 2 = commercial. */
export const PURPOSE_OF_SHIPMENT = 2;
/** `currency` param sent to Shiprocket. International orders are priced in USD. */
export const API_CURRENCY = 'USD';

// --- Order-create defaults (customs / export fields; not admin-editable in v1) -------------
/** All Vendure orders reaching fulfillment are prepaid. */
export const PAYMENT_METHOD_PREPAID = 'Prepaid';
/** `reasonOfExport` — 3 = commercial/sample per Shiprocket's enum. */
export const DEFAULT_REASON_OF_EXPORT = 3;
/** Incoterm sent as `Terms_Of_Invoice`. */
export const DEFAULT_TERMS_OF_INVOICE = 'CIF';
/** `order_type` bucket for international essentials shipments. */
export const DEFAULT_ORDER_TYPE = 'ESSENTIALS';
export const DEFAULT_COMMODITY = 'false';
export const DEFAULT_MIES = 'false';
export const DEFAULT_IGST_PAYMENT_STATUS = 'B';

/**
 * Default config used when nothing has been saved for a channel yet. `fxRate` is INR per 1 USD
 * (1 = treat the courier rate as already in the order currency). One starter box bracket is
 * provided so the calculator has dimensions to send before an admin customises the table.
 */
export const DEFAULT_SHIPROCKET_CONFIG: ShiprocketConfig = {
    pickupPincode: '',
    pickupLocationName: '',
    fxRate: 1,
    boxBrackets: [{ maxGrams: 2000, length: 20, breadth: 15, height: 10 }],
};

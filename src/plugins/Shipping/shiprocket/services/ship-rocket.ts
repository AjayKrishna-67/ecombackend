// src/plugins/shiprocket/services/ship-rocket.ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { CacheService, Logger } from '@vendure/core';
import axios from 'axios';
import { SHIPROCKET_API_URL, SHIPROCKET_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import {
    PluginInitOptions,
    RateApiResponse,
    RateCalculatorParams,
    CourierRate,
    PickupAddress,
    PickupAddressResponse,
    QuickRateParams,
    QuickRate,
    QuickRateResponse,
    CreateQuickOrderInput,
    QuickOrderResponse,
    CancelOrderResponse,
    OrderDetailsResponse,
    ShiprocketOrderDetails,
    AssignAwbResponse,
    QuickTrackingData,
    QuickTrackingResponse,
} from '../types';

// Tracking responses are short-cached so a busy order page doesn't hit
// Shiprocket's rate limit (same policy as the international integration).
const QUICK_TRACKING_TTL_MS = 3 * 60 * 1000;
const quickTrackingKey = (shipmentId: number) => `shiprocket:quick-track:${shipmentId}`;

interface AuthResponse {
    token: string;
}

const RATE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — rates rarely change intra-day
const RATE_CACHE_PREFIX = 'shiprocket:rate:';
const RATE_CACHE_TAG = 'shiprocket-rate';

const AUTH_TOKEN_TTL_MS = 9 * 24 * 60 * 60 * 1000; // 9 days — Shiprocket tokens last 10 days
const authTokenKey = (email: string) => `shiprocket:auth-token:${email}`;

// Couriers price by weight slabs and value brackets, not by exact grams/rupees.
// Bucketing the rate-cache inputs keeps the number of distinct cache keys tiny
// (a few per route instead of one per unique cart) and raises the cache hit rate.
// We always round UP so a quote is never lower than the real cost.
const WEIGHT_SLAB_KG = 0.5; // Shiprocket bills in 0.5kg slabs
const VALUE_BUCKET = 500;   // round declared value to the nearest ₹500 (upwards)
const bucketWeight = (kg: number) => Math.ceil(Math.max(WEIGHT_SLAB_KG, kg) / WEIGHT_SLAB_KG) * WEIGHT_SLAB_KG;
const bucketValue = (value: number) => Math.ceil(Math.max(0, value) / VALUE_BUCKET) * VALUE_BUCKET;

@Injectable()
export class ShipRocket implements OnModuleInit {
    constructor(
        @Inject(SHIPROCKET_PLUGIN_OPTIONS) private options: PluginInitOptions,
        private cacheService: CacheService,
    ) {}

    async onModuleInit() {
        Logger.info('Initializing Shiprocket Service...', loggerCtx);
        // Don't proactively authenticate on boot — wait until first getToken().
        // If another pod has already cached a token in Redis, we'll reuse it.
    }

    async getToken(): Promise<string> {
        const email = this.options.email;
        if (!email) {
            throw new Error('Shiprocket email is not configured.');
        }
        const cacheKey = authTokenKey(email);

        const cached = (await this.cacheService.get(cacheKey)) as string | undefined;
        if (cached) {
            return cached;
        }

        Logger.info('Shiprocket token cache miss — authenticating...', loggerCtx);
        const token = await this.authenticate();
        if (!token) {
            throw new Error('Could not retrieve Shiprocket auth token.');
        }
        return token;
    }

    private async authenticate(): Promise<string | null> {
        const url = `${SHIPROCKET_API_URL}/v1/external/auth/login`;
        const credentials = {
            email: this.options.email,
            password: this.options.password,
        };

        if (!credentials.email || !credentials.password) {
            Logger.error('Shiprocket email or password is not configured.', loggerCtx);
            return null;
        }

        try {
            Logger.info('Authenticating with Shiprocket API...', loggerCtx);
            const response = await axios.post<AuthResponse>(url, credentials, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000, // 10 second timeout
            });

            const token = response.data.token;
            await this.cacheService.set(authTokenKey(credentials.email), token as any, {
                ttl: AUTH_TOKEN_TTL_MS,
            });
            Logger.info('Successfully authenticated with Shiprocket API (token cached in Redis).', loggerCtx);
            return token;
        } catch (error: any) {
            const message = error.response?.data?.message || error.message;
            Logger.error(`Failed to authenticate with Shiprocket: ${message}`, loggerCtx);
            return null;
        }
    }

    private getCacheKey(params: RateCalculatorParams): string {
        // Bucket weight and value so near-identical carts share one cache entry.
        const weight = bucketWeight(params.weight_in_kg);
        const value = bucketValue(params.order_value);
        return `${RATE_CACHE_PREFIX}${params.pickup_postcode}_${params.delivery_postcode}_${weight}_${value}_${params.is_cod}`;
    }

    async getShippingRates(params: RateCalculatorParams): Promise<CourierRate[]> {
        const cacheKey = this.getCacheKey(params);

        const cachedRates = (await this.cacheService.get(cacheKey)) as CourierRate[] | undefined;
        if (cachedRates) {
            Logger.info('Returning cached shipping rates (Redis)', loggerCtx);
            return cachedRates;
        }

        const url = `${SHIPROCKET_API_URL}/v1/external/courier/serviceability/`;
        
        try {
            const token = await this.getToken();
            const payload = {
                pickup_postcode: params.pickup_postcode,
                delivery_postcode: params.delivery_postcode,
                cod: params.is_cod ? 1 : 0,
                weight: bucketWeight(params.weight_in_kg), // rounded up to 0.5kg slab (matches cache key)
                declared_value: bucketValue(params.order_value), // rounded up to ₹500 bucket (matches cache key)
            };

            Logger.info(`Fetching shipping rates for ${params.pickup_postcode} to ${params.delivery_postcode}`, loggerCtx);
            
            // =================================================================
            // NEW LOGGING ADDED HERE
            // This will show the exact data being sent to Shiprocket
            Logger.info(`Sending payload to Shiprocket: ${JSON.stringify(payload, null, 2)}`, loggerCtx);
            // =================================================================

            const response = await axios.get<RateApiResponse>(url, {
                headers: { 
                    'Content-Type': 'application/json', 
                    Authorization: `Bearer ${token}` 
                },
                params: payload,
                timeout: 15000, // 15 second timeout
            });

            // =================================================================
            // NEW LOGGING ADDED HERE
            // This will show the exact response received from Shiprocket
            Logger.info(`Full API Response from Shiprocket: ${JSON.stringify(response.data, null, 2)}`, loggerCtx);
            // =================================================================

            if (response.data?.status !== 200) {
                Logger.warn(`Shiprocket API returned non-200 status: ${response.data?.status}`, loggerCtx);
                return [];
            }

            const courierCompanies = response.data?.data?.available_courier_companies || [];
            
            if (courierCompanies.length === 0) {
                Logger.warn(`No shipping options found for pincode ${params.delivery_postcode}`, loggerCtx);
                return [];
            }

            // Sort by rate (cheapest first)
            const sortedRates = courierCompanies.sort((a, b) => a.rate - b.rate);

            // Filter out blocked couriers
            const availableRates = sortedRates.filter(rate => rate.blocked === 0);

            Logger.info(`Found ${availableRates.length} available shipping options.`, loggerCtx);

            await this.cacheService.set(cacheKey, availableRates as any, {
                ttl: RATE_CACHE_TTL_MS,
                tags: [RATE_CACHE_TAG],
            });

            return availableRates;

        } catch (error: any) {
            if (error.code === 'ECONNABORTED') {
                Logger.error('Shiprocket API request timed out', loggerCtx);
            } else {
                const message = error.response?.data?.message || error.message;
                Logger.error(`Failed to get shipping rates: ${message}`, loggerCtx);
                
                if (error.response) {
                    Logger.error(`Response status: ${error.response.status}`, loggerCtx);
                    Logger.error(`Response data: ${JSON.stringify(error.response.data)}`, loggerCtx);
                }
            }
            return [];
        }
    }

    async clearRateCache(): Promise<void> {
        await this.cacheService.invalidateTags([RATE_CACHE_TAG]);
        Logger.info('Shiprocket rate cache invalidated (Redis)', loggerCtx);
    }

    // =================================================================
    // Shiprocket Quick (hyperlocal) methods
    // =================================================================

    /**
     * Get all pickup addresses from Shiprocket
     */
    async getPickupAddresses(): Promise<PickupAddress[]> {
        const url = `${SHIPROCKET_API_URL}/v1/external/settings/company/pickup`;
        try {
            const token = await this.getToken();
            const response = await axios.get<PickupAddressResponse>(url, {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                timeout: 15000,
            });
            if (response.data?.data?.shipping_address) {
                Logger.info(`Retrieved ${response.data.data.shipping_address.length} pickup addresses`, loggerCtx);
                return response.data.data.shipping_address;
            }
            return [];
        } catch (error: any) {
            const message = error.response?.data?.message || error.message;
            Logger.error(`Failed to get pickup addresses: ${message}`, loggerCtx);
            if (error.response) {
                Logger.error(`Response status: ${error.response.status}`, loggerCtx);
                Logger.error(`Response data: ${JSON.stringify(error.response.data)}`, loggerCtx);
            }
            return [];
        }
    }

    /**
     * Calculate distance between two coordinates using the Haversine formula (km).
     */
    private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371; // Radius of the Earth in km
        const dLat = this.toRad(lat2 - lat1);
        const dLon = this.toRad(lon2 - lon1);
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    private toRad(degrees: number): number {
        return degrees * (Math.PI / 180);
    }

    /**
     * Find the nearest pickup address to the delivery location.
     * When priority pincodes are configured, ONLY addresses matching those
     * pincodes are considered (nearest by distance); otherwise the nearest of
     * all active addresses with valid coordinates is used.
     */
    async findNearestPickupAddress(
        deliveryLat: number,
        deliveryLong: number,
        deliveryPincode?: string,
        deliveryCity?: string,
        priorityPincodes?: string[],
    ): Promise<PickupAddress | null> {
        const pickupAddresses = await this.getPickupAddresses();
        if (pickupAddresses.length === 0) {
            Logger.warn('No pickup addresses found', loggerCtx);
            return null;
        }
        // Status 1 and 2 are both considered active in Shiprocket.
        const validAddresses = pickupAddresses.filter(address => {
            if (!address.lat || !address.long || (address.status !== 1 && address.status !== 2)) {
                return false;
            }
            const lat = parseFloat(address.lat);
            const long = parseFloat(address.long);
            return !isNaN(lat) && !isNaN(long);
        });
        if (validAddresses.length === 0) {
            Logger.warn('No active pickup addresses with valid coordinates found', loggerCtx);
            return null;
        }
        Logger.info(
            `Finding pickup address for delivery: pincode="${deliveryPincode}", city="${deliveryCity}", coords=(${deliveryLat}, ${deliveryLong}), priorityPincodes=[${priorityPincodes?.join(', ') || 'none'}]`,
            loggerCtx,
        );
        const findNearestByDistance = (addresses: PickupAddress[]): { address: PickupAddress | null; distance: number } => {
            let nearest: PickupAddress | null = null;
            let minDistance = Infinity;
            for (const address of addresses) {
                const lat = parseFloat(address.lat);
                const long = parseFloat(address.long);
                const distance = this.calculateDistance(deliveryLat, deliveryLong, lat, long);
                if (distance < minDistance) {
                    minDistance = distance;
                    nearest = address;
                }
            }
            return { address: nearest, distance: minDistance };
        };
        const normalizedPriorityPincodes = (priorityPincodes || [])
            .map(p => String(p).trim())
            .filter(p => p.length > 0);
        // When priority pincodes are configured, ONLY use those addresses.
        if (normalizedPriorityPincodes.length > 0) {
            const priorityAddresses = validAddresses.filter(address =>
                normalizedPriorityPincodes.includes(String(address.pin_code).trim()),
            );
            if (priorityAddresses.length === 0) {
                Logger.warn(
                    `No pickup addresses found matching priority pincodes [${normalizedPriorityPincodes.join(', ')}]`,
                    loggerCtx,
                );
                return null;
            }
            const result = findNearestByDistance(priorityAddresses);
            if (result.address) {
                Logger.info(
                    `Selected nearest priority pickup: ${result.address.pickup_location} (${result.address.pin_code}, ${result.address.city}) - ${result.distance.toFixed(2)} km from delivery`,
                    loggerCtx,
                );
            }
            return result.address;
        }
        const result = findNearestByDistance(validAddresses);
        if (result.address) {
            Logger.info(
                `Selected nearest pickup by distance: ${result.address.pickup_location} (${result.address.pin_code}, ${result.address.city}) - ${result.distance.toFixed(2)} km from delivery`,
                loggerCtx,
            );
        }
        return result.address;
    }

    /**
     * Get Quick (hyperlocal) shipping rates based on coordinates.
     */
    async getQuickShippingRates(params: QuickRateParams): Promise<QuickRate[]> {
        const url = `${SHIPROCKET_API_URL}/v1/external/courier/serviceability/`;
        try {
            const token = await this.getToken();
            Logger.info(
                `Fetching Quick shipping rates from (${params.lat_from}, ${params.long_from}) to (${params.lat_to}, ${params.long_to})`,
                loggerCtx,
            );
            const response = await axios.get<QuickRateResponse>(url, {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                params,
                timeout: 15000,
            });
            if (response.data?.status && response.data?.data) {
                Logger.info(`Found ${response.data.data.length} Quick shipping options`, loggerCtx);
                return response.data.data;
            }
            Logger.warn(`No Quick rates found. Response: ${JSON.stringify(response.data)}`, loggerCtx);
            return [];
        } catch (error: any) {
            const message = error.response?.data?.message || error.message;
            Logger.error(`Failed to get Quick shipping rates: ${message}`, loggerCtx);
            if (error.response) {
                Logger.error(`Response status: ${error.response.status}`, loggerCtx);
                Logger.error(`Response data: ${JSON.stringify(error.response.data)}`, loggerCtx);
            }
            return [];
        }
    }

    /**
     * Create a Quick order in Shiprocket.
     */
    async createQuickOrder(orderData: CreateQuickOrderInput): Promise<QuickOrderResponse | null> {
        const url = `${SHIPROCKET_API_URL}/v1/external/orders/create/adhoc`;
        try {
            const token = await this.getToken();
            Logger.info(`Creating Quick order: ${orderData.order_id}`, loggerCtx);
            const response = await axios.post<QuickOrderResponse>(url, orderData, {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                timeout: 20000,
            });
            Logger.info(
                `Quick order created successfully: Order ID ${response.data.order_id}, Shipment ID ${response.data.shipment_id}`,
                loggerCtx,
            );
            return response.data;
        } catch (error: any) {
            const message = error.response?.data?.message || error.message;
            Logger.error(`Failed to create Quick order: ${message}`, loggerCtx);
            if (error.response) {
                Logger.error(`Response status: ${error.response.status}`, loggerCtx);
                Logger.error(`Response data: ${JSON.stringify(error.response.data)}`, loggerCtx);
            }
            return null;
        }
    }

    /**
     * Cancel Quick orders in Shiprocket.
     * @param orderIds - Shiprocket order IDs (not Vendure order IDs).
     */
    async cancelQuickOrder(orderIds: number[]): Promise<boolean> {
        const url = `${SHIPROCKET_API_URL}/v1/external/orders/cancel`;
        try {
            const token = await this.getToken();
            Logger.info(`Cancelling Quick orders: ${orderIds.join(', ')}`, loggerCtx);
            const response = await axios.post<CancelOrderResponse>(url, { ids: orderIds }, {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                timeout: 15000,
            });
            if (response.data?.status_code === 200) {
                Logger.info(`Orders cancelled successfully: ${response.data.message}`, loggerCtx);
                return true;
            }
            return false;
        } catch (error: any) {
            const message = error.response?.data?.message || error.message;
            Logger.error(`Failed to cancel Quick order: ${message}`, loggerCtx);
            if (error.response) {
                Logger.error(`Response status: ${error.response.status}`, loggerCtx);
                Logger.error(`Response data: ${JSON.stringify(error.response.data)}`, loggerCtx);
            }
            return false;
        }
    }

    /**
     * Get order details from Shiprocket.
     * @param orderId - Shiprocket order ID.
     */
    async getOrderDetails(orderId: number): Promise<ShiprocketOrderDetails | null> {
        const url = `${SHIPROCKET_API_URL}/v1/external/orders/show/${orderId}`;
        try {
            const token = await this.getToken();
            const response = await axios.get<OrderDetailsResponse>(url, {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                timeout: 15000,
            });
            if (response.data?.data) {
                return response.data.data;
            }
            Logger.warn(`No order details found for order ID: ${orderId}`, loggerCtx);
            return null;
        } catch (error: any) {
            const message = error.response?.data?.message || error.message;
            Logger.error(`Failed to get order details: ${message}`, loggerCtx);
            if (error.response) {
                Logger.error(`Response status: ${error.response.status}`, loggerCtx);
                Logger.error(`Response data: ${JSON.stringify(error.response.data)}`, loggerCtx);
            }
            return null;
        }
    }

    /**
     * Live tracking for a Quick shipment by shipment id
     * (`GET /courier/track/shipment/{shipment_id}`).
     *
     * Chosen over track-by-AWB because hyperlocal shipments have no AWB until
     * a rider is assigned — the shipment id exists from order creation, and
     * the AWB appears inside the tracking data once assigned.
     */
    async trackQuickShipment(shipmentId: number): Promise<QuickTrackingData | null> {
        const cacheKey = quickTrackingKey(shipmentId);
        const cached = (await this.cacheService.get(cacheKey)) as QuickTrackingData | undefined;
        if (cached) {
            return cached;
        }
        const url = `${SHIPROCKET_API_URL}/v1/external/courier/track/shipment/${shipmentId}`;
        try {
            const token = await this.getToken();
            const response = await axios.get<QuickTrackingResponse>(url, {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                timeout: 15000,
            });
            // Response is keyed by shipment id: { "<shipmentId>": { tracking_data } }.
            // Fall back to a bare tracking_data / first entry in case Shiprocket
            // ever aligns this with the track/awb shape.
            const body = response.data as any;
            const trackingData: QuickTrackingData | undefined =
                body?.[String(shipmentId)]?.tracking_data ??
                body?.tracking_data ??
                (Object.values(body ?? {})[0] as any)?.tracking_data;
            if (!trackingData) {
                Logger.warn(`No tracking data for shipment ID: ${shipmentId}`, loggerCtx);
                return null;
            }
            await this.cacheService.set(cacheKey, trackingData as any, { ttl: QUICK_TRACKING_TTL_MS });
            return trackingData;
        } catch (error: any) {
            const message = error.response?.data?.message || error.message;
            Logger.error(`Failed to track shipment ${shipmentId}: ${message}`, loggerCtx);
            if (error.response) {
                Logger.error(`Response status: ${error.response.status}`, loggerCtx);
                Logger.error(`Response data: ${JSON.stringify(error.response.data)}`, loggerCtx);
            }
            return null;
        }
    }

    /**
     * Assign an AWB (airway bill) to a shipment to trigger shipping.
     * @param shipmentId - Shiprocket shipment ID.
     * @param courierId - Optional courier company ID (uses default if not specified).
     */
    async assignAwb(shipmentId: number, courierId?: number): Promise<AssignAwbResponse | null> {
        const url = `${SHIPROCKET_API_URL}/v1/external/courier/assign/awb`;
        try {
            const token = await this.getToken();
            const payload: Record<string, any> = { shipment_id: shipmentId };
            if (courierId) {
                payload.courier_id = courierId;
            }
            Logger.info(`Assigning AWB for shipment ID: ${shipmentId}`, loggerCtx);
            const response = await axios.post<AssignAwbResponse>(url, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                timeout: 20000,
            });
            Logger.info(`AWB assignment response: ${JSON.stringify(response.data)}`, loggerCtx);
            return response.data;
        } catch (error: any) {
            const message = error.response?.data?.message || error.message;
            Logger.error(`Failed to assign AWB: ${message}`, loggerCtx);
            if (error.response) {
                Logger.error(`Response status: ${error.response.status}`, loggerCtx);
                Logger.error(`Response data: ${JSON.stringify(error.response.data)}`, loggerCtx);
            }
            return null;
        }
    }
}
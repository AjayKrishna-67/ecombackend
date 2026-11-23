import { Inject, Injectable } from '@nestjs/common';
import { Logger } from '@vendure/core';
import axios, { AxiosInstance } from 'axios';

import { ADLOGGS_PLUGIN_OPTIONS, loggerCtx } from '../constants';
import {
    AdloggsAvailabilityRequest,
    AdloggsAvailabilityResponseData,
    AdloggsCreateOrderRequest,
    AdloggsCreateOrderResponseData,
    AdloggsCurrentStatusData,
    AdloggsEnvelope,
    PluginInitOptions,
} from '../types';

/**
 * Thin IO client for the Adloggs partner REST API.
 *
 * Every method returns the raw Adloggs envelope ({ status, code, message, data })
 * so callers can distinguish "service said no" (envelope.status === false) from
 * transport failures (thrown). Adloggs returns most business errors as HTTP 200
 * with status:false; auth errors come as HTTP 400 — both are normalized into a
 * resolved envelope here.
 *
 * Timeouts are per-endpoint: availability is on the checkout hot path so it gets
 * a short timeout; create is given more room because Adloggs does its rider/route
 * work synchronously (observed >30s hangs on dev when their downstream stalls).
 */
@Injectable()
export class AdloggsService {
    private http: AxiosInstance;

    constructor(@Inject(ADLOGGS_PLUGIN_OPTIONS) private options: PluginInitOptions) {
        this.http = axios.create({
            baseURL: this.options.apiHost,
            headers: {
                'x-api-key': this.options.apiKey,
                'Content-Type': 'application/json',
            },
            // Adloggs signals errors in the body, not the HTTP status. Accept
            // everything and let callers read the envelope.
            validateStatus: () => true,
        });
    }

    get isConfigured(): boolean {
        return !!(this.options.apiHost && this.options.apiKey);
    }

    async createOrder(payload: AdloggsCreateOrderRequest): Promise<AdloggsEnvelope<AdloggsCreateOrderResponseData>> {
        return this.post('/aa/oporder/v2/create', payload, 45_000);
    }

    async checkAvailability(
        payload: AdloggsAvailabilityRequest,
        timeoutMs = 8_000,
    ): Promise<AdloggsEnvelope<AdloggsAvailabilityResponseData>> {
        return this.post('/aa/oporder/v1.2/service/availability', payload, timeoutMs);
    }

    async getCurrentStatus(orderUuid: string): Promise<AdloggsEnvelope<AdloggsCurrentStatusData>> {
        return this.post('/aa/oporder/getcurrentstatus', { order_uuid: orderUuid }, 15_000);
    }

    async cancelOrder(orderUuid: string, reason: string): Promise<AdloggsEnvelope<{}>> {
        return this.post(
            '/aa/oporder/v1.2/cancel',
            { order_uuid: orderUuid, order_cancel_description: reason },
            15_000,
        );
    }

    async getWalletBalance(): Promise<AdloggsEnvelope<{ wallet_balance?: string; code?: string }>> {
        return this.post('/aa/oporder/wallet/balance', {}, 15_000);
    }

    /**
     * Approximate coordinates for an Indian pincode (+ optional city), for
     * addresses that carry no map pin — admin draft orders, mainly. Uses
     * Nominatim (no key needed) with a short timeout and an in-memory cache;
     * returns null when it cannot resolve, so callers can skip quoting.
     */
    async geocodePincode(pincode: string, city?: string | null): Promise<{ lat: number; long: number } | null> {
        const key = `${pincode}|${(city ?? '').trim().toLowerCase()}`;
        const cached = AdloggsService.geocodeCache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const queries = [
            `postalcode=${encodeURIComponent(pincode)}&countrycodes=in`,
            `q=${encodeURIComponent([pincode, city, 'India'].filter(Boolean).join(', '))}&countrycodes=in`,
        ];
        let result: { lat: number; long: number } | null = null;
        for (const q of queries) {
            try {
                const res = await axios.get(`https://nominatim.openstreetmap.org/search?${q}&format=jsonv2&limit=1`, {
                    timeout: 5_000,
                    headers: { Accept: 'application/json', 'User-Agent': 'KaaiKani-Vendure/adloggs' },
                });
                const hit = res.data?.[0];
                if (hit?.lat && hit?.lon) {
                    result = { lat: parseFloat(hit.lat), long: parseFloat(hit.lon) };
                    break;
                }
            } catch (error: any) {
                Logger.warn(`Pincode geocode failed for ${pincode}: ${error.message}`, loggerCtx);
            }
        }
        AdloggsService.geocodeCache.set(key, result);
        return result;
    }

    /** Pincode → coordinates cache (process lifetime; pincodes do not move). */
    private static geocodeCache = new Map<string, { lat: number; long: number } | null>();

    /**
     * Delivery coordinates for an order: the customer's map pin when present,
     * otherwise a pincode-level approximation. `approximate` tells callers to
     * label the result.
     */
    async resolveDeliveryPoint(shippingAddress: {
        postalCode?: string | null;
        city?: string | null;
        customFields?: any;
    } | undefined): Promise<{ lat: number; long: number; approximate: boolean } | null> {
        const cf = shippingAddress?.customFields ?? {};
        if (cf.latitude && cf.longitude) {
            return { lat: Number(cf.latitude), long: Number(cf.longitude), approximate: false };
        }
        if (!shippingAddress?.postalCode) {
            return null;
        }
        const geo = await this.geocodePincode(shippingAddress.postalCode, shippingAddress.city);
        return geo ? { ...geo, approximate: true } : null;
    }

    private async post<T>(path: string, body: unknown, timeout: number): Promise<AdloggsEnvelope<T>> {
        if (!this.isConfigured) {
            return { status: false, code: 0, message: 'Adloggs is not configured (ADLOGGS_HOST / ADLOGGS_API_KEY)', data: {} as T };
        }
        try {
            const response = await this.http.post(path, body, { timeout });
            const envelope = response.data;
            if (!envelope || typeof envelope.status !== 'boolean') {
                Logger.error(
                    `Unexpected Adloggs response from ${path}: HTTP ${response.status}`,
                    loggerCtx,
                );
                return {
                    status: false,
                    code: response.status,
                    message: `Unexpected response from Adloggs (HTTP ${response.status})`,
                    data: {} as T,
                };
            }
            if (!envelope.status) {
                Logger.warn(`Adloggs ${path} refused: ${envelope.message || envelope.err}`, loggerCtx);
            }
            return envelope;
        } catch (error: any) {
            const reason = error.code === 'ECONNABORTED' ? `timed out after ${timeout}ms` : error.message;
            Logger.error(`Adloggs ${path} failed: ${reason}`, loggerCtx);
            return { status: false, code: 0, message: `Adloggs request failed: ${reason}`, data: {} as T };
        }
    }
}

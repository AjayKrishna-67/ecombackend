import { Injectable } from '@nestjs/common';
import { CacheService, Logger } from '@vendure/core';
import axios from 'axios';

import {
    loggerCtx,
    SHIPROCKET_API_BASE,
    SHIPROCKET_CREATE_ADHOC_PATH,
    SHIPROCKET_ORDER_CANCEL_PATH,
    SHIPROCKET_ORDER_SHOW_PATH,
    SHIPROCKET_TRACK_AWB_PATH,
    TRACKING_TTL_MS,
} from '../constants';
import {
    ShiprocketAdhocOrderPayload,
    ShiprocketCreateOrderResponse,
    ShiprocketOrderDetailsResponse,
    ShiprocketTracking,
    ShiprocketTrackingResponse,
} from '../types';
import { ShiprocketService } from './shiprocket.service';

/**
 * Order-lifecycle IO for Shiprocket: create the international order (fulfillment), refresh its
 * details, and track by AWB. Reuses the auth-token cache on {@link ShiprocketService}. Tracking is
 * fetched live (short-cached) so the storefront can show a current timeline without a webhook.
 */
@Injectable()
export class ShiprocketOrderService {
    constructor(
        private cacheService: CacheService,
        private shiprocket: ShiprocketService,
    ) {}

    /**
     * Creates the Shiprocket order via `create/adhoc`. **Throws** on failure (so the fulfillment
     * is rolled back and the admin sees why) with the Shiprocket error message when present.
     */
    async createAdhocOrder(payload: ShiprocketAdhocOrderPayload): Promise<ShiprocketCreateOrderResponse> {
        const token = await this.shiprocket.getToken();
        const url = `${SHIPROCKET_API_BASE}${SHIPROCKET_CREATE_ADHOC_PATH}`;
        try {
            const resp = await axios.post<ShiprocketCreateOrderResponse>(url, payload, {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                timeout: 30000,
            });
            if (!resp.data?.order_id) {
                throw new Error(`Shiprocket did not return an order_id: ${JSON.stringify(resp.data)}`);
            }
            return resp.data;
        } catch (e: any) {
            // Shiprocket 422s carry the useful detail in `errors` next to a generic `message`
            // ("Oops! Invalid Data.") — log the whole body and surface the field errors.
            const data = e?.response?.data;
            Logger.error(
                `Shiprocket order create failed (HTTP ${e?.response?.status ?? '?'}): ` +
                    (data ? JSON.stringify(data) : e?.message),
                loggerCtx,
            );
            Logger.debug(`Rejected payload: ${JSON.stringify(payload)}`, loggerCtx);
            const fieldErrors = data?.errors
                ? Object.entries(data.errors as Record<string, unknown>)
                      .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? msgs.join(', ') : String(msgs)}`)
                      .join('; ')
                : '';
            const message = data?.message ?? e?.message ?? 'Shiprocket order create failed';
            throw new Error(fieldErrors ? `${message} — ${fieldErrors}` : message);
        }
    }

    /**
     * Fetches order details from `orders/show/{id}`. Returns `undefined` (never throws) on failure
     * so a "Sync" action degrades gracefully.
     */
    async getOrderDetails(srOrderId: string | number): Promise<ShiprocketOrderDetailsResponse | undefined> {
        try {
            const token = await this.shiprocket.getToken();
            const url = `${SHIPROCKET_API_BASE}${SHIPROCKET_ORDER_SHOW_PATH}${srOrderId}`;
            const resp = await axios.get<ShiprocketOrderDetailsResponse>(url, {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 20000,
            });
            return resp.data;
        } catch (e: any) {
            Logger.error(`Shiprocket order show failed for ${srOrderId}: ${e.message}`, loggerCtx);
            return undefined;
        }
    }

    /**
     * Cancels a Shiprocket order (`orders/cancel`). Returns `true` on success, `false` on failure
     * (logged) — callers decide whether to block; we deliberately never throw so a Shiprocket
     * outage cannot leave a Vendure fulfillment stuck un-cancellable.
     */
    async cancelOrder(srOrderId: string | number): Promise<boolean> {
        try {
            const token = await this.shiprocket.getToken();
            const url = `${SHIPROCKET_API_BASE}${SHIPROCKET_ORDER_CANCEL_PATH}`;
            await axios.post(
                url,
                { ids: [Number(srOrderId)] },
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 },
            );
            Logger.info(`Cancelled Shiprocket order ${srOrderId}`, loggerCtx);
            return true;
        } catch (e: any) {
            const data = e?.response?.data;
            Logger.error(
                `Shiprocket order cancel failed for ${srOrderId}: ` +
                    (data ? JSON.stringify(data) : e?.message),
                loggerCtx,
            );
            return false;
        }
    }

    /**
     * Live tracking by AWB (short-cached). Returns `undefined` when the AWB is missing or the call
     * fails, so callers can render "not yet available".
     */
    async trackByAwb(awb: string): Promise<ShiprocketTracking | undefined> {
        if (!awb) {
            return undefined;
        }
        const cacheKey = `shiprocket:track:${awb}`;
        const cached = (await this.cacheService.get<ShiprocketTracking>(cacheKey)) as
            | ShiprocketTracking
            | undefined;
        if (cached) {
            return cached;
        }
        try {
            const token = await this.shiprocket.getToken();
            const url = `${SHIPROCKET_API_BASE}${SHIPROCKET_TRACK_AWB_PATH}${awb}`;
            const resp = await axios.get<ShiprocketTrackingResponse>(url, {
                headers: { Authorization: `Bearer ${token}` },
                timeout: 20000,
            });
            const tracking = normaliseTracking(awb, resp.data);
            if (tracking) {
                await this.cacheService.set(cacheKey, tracking as any, { ttl: TRACKING_TTL_MS });
            }
            return tracking;
        } catch (e: any) {
            Logger.error(`Shiprocket track failed for AWB ${awb}: ${e.message}`, loggerCtx);
            return undefined;
        }
    }
}

/** Pure normaliser: Shiprocket's tracking response → our flat {@link ShiprocketTracking}. */
export function normaliseTracking(
    awb: string,
    resp: ShiprocketTrackingResponse | undefined,
): ShiprocketTracking | undefined {
    const td = resp?.tracking_data;
    if (!td) {
        return undefined;
    }
    const first = td.shipment_track?.[0];
    const activities = (td.shipment_track_activities ?? []).map(a => ({
        date: a.date,
        status: a.status,
        activity: a.activity,
        location: a.location,
        srStatus: a['sr-status'] != null ? String(a['sr-status']) : null,
        srStatusLabel: a['sr-status-label'] ?? null,
    }));
    return {
        awb,
        courierName: first?.courier_name ?? null,
        currentStatus: first?.current_status ?? null,
        etd: td.etd ?? first?.edd ?? null,
        trackUrl: td.track_url ?? null,
        activities,
    };
}

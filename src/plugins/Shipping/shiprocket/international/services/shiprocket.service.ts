import { Injectable } from '@nestjs/common';
import {
    CacheService,
    EntityHydrator,
    Logger,
    Order,
    RequestContext,
    SettingsStoreService,
    TransactionalConnection,
} from '@vendure/core';
import axios from 'axios';

import { resolveVariantMeasures } from '../../../../Stock/shared/resolve-variant-measure';

import {
    API_CURRENCY,
    DEFAULT_SHIPROCKET_CONFIG,
    loggerCtx,
    PURPOSE_OF_SHIPMENT,
    SERVICEABILITY_TTL_MS,
    SHIPROCKET_API_BASE,
    SHIPROCKET_CONFIG_KEY,
    SHIPROCKET_SERVICEABILITY_PATH,
} from '../constants';
import {
    ServiceabilityQuery,
    ShiprocketConfig,
    ShiprocketServiceabilityResponse,
} from '../types';
import { ShipRocket } from '../../services/ship-rocket';

/**
 * IO layer for Shiprocket: channel-scoped config, auth-token caching, the serviceability call,
 * and deriving shipment weight / HSN codes from an order. All pure pricing math lives in
 * `config/pricing.ts` so it can be unit-tested without mocking this service.
 */
@Injectable()
export class ShiprocketService {
    constructor(
        private cacheService: CacheService,
        private settingsStore: SettingsStoreService,
        private entityHydrator: EntityHydrator,
        private shipRocket: ShipRocket,
        private connection: TransactionalConnection,
    ) {}

    /** Channel-scoped config, with stored values merged over defaults (backfills new fields). */
    async getConfig(ctx: RequestContext): Promise<ShiprocketConfig> {
        const stored = (await this.settingsStore.get(SHIPROCKET_CONFIG_KEY, ctx)) as
            | Partial<ShiprocketConfig>
            | undefined;
        return { ...DEFAULT_SHIPROCKET_CONFIG, ...(stored ?? {}) };
    }

    /**
     * Returns a Shiprocket bearer token. Delegates to the shared {@link ShipRocket}
     * service so Quick and International reuse one cached login (SHIPROCKET_EMAIL /
     * SHIPROCKET_PASSWORD, token cached ~9 days in the CacheService).
     */
    async getToken(): Promise<string> {
        return this.shipRocket.getToken();
    }

    /**
     * Calls the international serviceability endpoint. Returns `undefined` (never throws) on auth
     * or network failure so the calculator simply hides the method instead of breaking checkout.
     * Successful responses are cached for a few minutes, keyed by every rate-affecting param.
     */
    async getServiceability(
        query: ServiceabilityQuery,
    ): Promise<ShiprocketServiceabilityResponse | undefined> {
        const cacheKey = this.serviceabilityCacheKey(query);
        const cached = (await this.cacheService.get<any>(cacheKey)) as
            | ShiprocketServiceabilityResponse
            | undefined;
        if (cached) {
            return cached;
        }
        let token: string;
        try {
            token = await this.getToken();
        } catch (e: any) {
            Logger.error(`Shiprocket auth failed: ${e.message}`, loggerCtx);
            return undefined;
        }
        try {
            const url = `${SHIPROCKET_API_BASE}${SHIPROCKET_SERVICEABILITY_PATH}`;
            const resp = await axios.get<ShiprocketServiceabilityResponse>(url, {
                params: {
                    purpose_of_shipment: PURPOSE_OF_SHIPMENT,
                    delivery_country: query.deliveryCountry,
                    from: 'calculator',
                    pickup_postcode: query.pickupPincode,
                    weight: query.weightKg,
                    length: query.length,
                    breadth: query.breadth,
                    height: query.height,
                    cod: query.cod,
                    hsn_codes: query.hsnCodes,
                    currency: API_CURRENCY,
                },
                headers: { Authorization: `Bearer ${token}` },
                timeout: 20000,
            });
            const data = resp.data;
            if (data?.status === 200 && Array.isArray(data.data?.available_courier_companies)) {
                await this.cacheService.set(cacheKey, data as any, { ttl: SERVICEABILITY_TTL_MS });
            }
            return data;
        } catch (e: any) {
            Logger.error(`Shiprocket serviceability request failed: ${e.message}`, loggerCtx);
            return undefined;
        }
    }

    /**
     * Total cart weight in grams (Σ option weight × qty) and the comma-joined set of product HSN
     * codes, hydrating `lines.productVariant.product` so both custom fields are available.
     */
    async getShipmentData(
        ctx: RequestContext,
        order: Order,
    ): Promise<{ weightGrams: number; hsnCodes: string }> {
        // Only hydrate a persisted order. A transient order (no id, as built by
        // testShippingMethod's buildMockOrder) would make EntityHydrator issue
        // `where: { id: undefined }`, which TypeORM turns into an unfiltered query that loads the
        // entire orders table with deep relations — multi-GB and hangs the event loop.
        if (order.id != null) {
            await this.entityHydrator.hydrate(ctx, order, {
                // `options` comes along so the measure resolver reads it in
                // memory instead of issuing its own query.
                relations: ['lines.productVariant.product', 'lines.productVariant.options'],
            });
        }
        // Weight comes from each variant's option (measureValue + measureUnit).
        const measures = await resolveVariantMeasures(
            ctx,
            this.connection,
            order.lines.map(l => l.productVariant).filter(Boolean),
        );
        let weightGrams = 0;
        const codes = new Set<string>();
        for (const line of order.lines) {
            const variant: any = line.productVariant;
            // For transient orders the variants are already loaded but their `product` relation may
            // not be — hydrate the variant (which always has a valid id) to reach hsnCode safely.
            if (variant && !variant.product) {
                await this.entityHydrator.hydrate(ctx, variant, { relations: ['product'] });
            }
            const w = measures.get(String(variant?.id))?.grams ?? 0;
            weightGrams += w * line.quantity;
            const hsn = variant?.product?.customFields?.hsnCode;
            if (hsn) {
                codes.add(String(hsn));
            }
        }
        return { weightGrams, hsnCodes: [...codes].join(',') };
    }

    private serviceabilityCacheKey(q: ServiceabilityQuery): string {
        return [
            'shiprocket:serv',
            q.pickupPincode,
            q.deliveryCountry,
            q.weightKg,
            `${q.length}x${q.breadth}x${q.height}`,
            q.hsnCodes,
            q.cod,
        ].join(':');
    }
}

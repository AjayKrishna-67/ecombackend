import { Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import {
    ChannelService,
    ID,
    JsonCompatible,
    Order,
    RequestContext,
    RequestContextService,
    SettingsStoreService,
    TransactionalConnection,
} from '@vendure/core';
import { ABANDONED_CART_SETTING_KEY, DEFAULT_ABANDONED_CART_CONFIG } from '../constants';
import { AbandonedCartEvent } from '../entities/abandoned-cart-event.entity';
import { AbandonedCartNudge } from '../entities/abandoned-cart-nudge.entity';
import { assembleAnalytics } from '../functions/assemble-analytics';
import { decideConversionEvent } from '../functions/decide-conversion-event';
import { isCartEligible } from '../functions/is-cart-eligible';
import { resolveBodyVars } from '../functions/resolve-body-vars';
import { stageDelaySeconds } from '../functions/stage-delay-seconds';
import { resolveOrderPhone } from '../functions/resolve-order-phone';
import { validateAbandonedCartConfig } from '../functions/validate-config';
import { AbandonedCartAnalytics, AbandonedCartConfig } from '../types';
import { Msg91Service } from './msg91.service';

/** The stage index (1-based) to send and the row to persist after a successful send. */
interface NudgeDecision {
    stageToSend: number;
    row: AbandonedCartNudge;
}

/**
 * Channel-scoped settings access + the sweep logic for abandoned-cart nudges.
 * `processOrder` is kept dependency-free so it can be unit-tested without DB or network.
 */
@Injectable()
export class AbandonedCartService {
    constructor(
        private connection: TransactionalConnection,
        private settingsStore: SettingsStoreService,
        private channelService: ChannelService,
        private requestContextService: RequestContextService,
        private msg91: Msg91Service,
    ) {}

    /**
     * Reads the channel-scoped config, falling back to defaults. Stored configs are merged over the
     * defaults so older records (saved before newer fields like costPerMessageMinor existed) are
     * backfilled instead of returning null for a non-nullable GraphQL field.
     */
    async readConfig(ctx: RequestContext): Promise<AbandonedCartConfig> {
        const stored = (await this.settingsStore.get(ABANDONED_CART_SETTING_KEY, ctx)) as
            | Partial<AbandonedCartConfig>
            | undefined;
        if (!stored) {
            return DEFAULT_ABANDONED_CART_CONFIG;
        }
        const merged: AbandonedCartConfig = { ...DEFAULT_ABANDONED_CART_CONFIG, ...stored };
        try {
            validateAbandonedCartConfig(merged);
            return merged;
        } catch (error: any) {
            console.warn(`[AbandonedCart] stored config invalid, using defaults: ${error.message}`);
            return DEFAULT_ABANDONED_CART_CONFIG;
        }
    }

    /** Validates then persists the channel-scoped config. */
    async writeConfig(ctx: RequestContext, config: AbandonedCartConfig): Promise<AbandonedCartConfig> {
        validateAbandonedCartConfig(config);
        await this.settingsStore.set(ABANDONED_CART_SETTING_KEY, config as unknown as JsonCompatible<any>, ctx);
        return config;
    }

    /**
     * Pure-ish decision: given an order, its channel config, an existing nudge row (if any),
     * and the current time, returns the stage to send and the updated row — or null to skip.
     * No async, no DB, no network. Safe to unit-test directly.
     *
     * Timing is GAP-based, not absolute: each stage's delay is the wait AFTER the previous
     * message was sent. Stage 1 counts from the cart's createdAt; stage N (N>1) counts from
     * lastSentAt (the previous stage's send time). So delays 30m/1h/2h on a cart abandoned at
     * 10:00 deliver at 10:30, then 1h later (11:30), then 2h later (13:30). One stage per sweep.
     */
    processOrder(
        order: Order,
        config: AbandonedCartConfig,
        existing: AbandonedCartNudge | undefined,
        now: Date,
    ): NudgeDecision | null {
        const eligible = isCartEligible({
            state: order.state as unknown as string,
            phoneNumber: resolveOrderPhone(order),
            totalWithTax: order.totalWithTax,
            minOrderValueMinor: config.minOrderValueMinor,
        });
        if (!eligible) {
            return null;
        }
        const stagesSent = existing?.stagesSent ?? 0;
        const nextStage = stagesSent + 1;
        if (nextStage > config.stages.length) {
            return null;
        }
        // Gap anchor: stage 1 waits from cart creation; later stages wait from the previous send.
        const anchor =
            stagesSent === 0 || !existing?.lastSentAt
                ? new Date(order.createdAt)
                : new Date(existing.lastSentAt);
        const elapsedSeconds = (now.getTime() - anchor.getTime()) / 1000;
        if (elapsedSeconds < stageDelaySeconds(config.stages[nextStage - 1])) {
            return null;
        }
        const row =
            existing ??
            new AbandonedCartNudge({
                orderId: String(order.id),
                channelId: String(order.channels?.[0]?.id ?? ''),
                stagesSent: 0,
                lastSentAt: null,
            });
        row.stagesSent = nextStage;
        row.lastSentAt = now;
        return { stageToSend: nextStage, row };
    }

    /** Iterates every channel, reads its config, and nudges eligible carts. */
    async sweep(rootCtx: RequestContext): Promise<void> {
        const channels = await this.channelService.findAll(rootCtx, { take: 1000 });
        for (const channel of channels.items) {
            const ctx = await this.requestContextService.create({ apiType: 'admin', channelOrToken: channel });
            const config = await this.readConfig(ctx);
            if (!config.enabled) {
                continue;
            }
            await this.sweepChannel(ctx, config);
        }
    }

    private async sweepChannel(ctx: RequestContext, config: AbandonedCartConfig): Promise<void> {
        const orderRepo = this.connection.getRepository(ctx, Order);
        const nudgeRepo = this.connection.getRepository(ctx, AbandonedCartNudge);
        const orders = (
            await orderRepo.find({
                where: { state: 'AddingItems' as any },
                relations: { customer: true, channels: true },
            })
        ).filter(order => order.channels?.some(channel => String(channel.id) === String(ctx.channelId)));
        // Batch-load existing nudge rows for all carts in one query (avoids an N+1 findOne per cart).
        // Nudge tracking is order-scoped (unique on orderId), NOT per-channel: a cart is nudged at
        // most once per stage globally; channelId on the row records which channel actually sent it.
        const orderIds = orders.map(order => String(order.id));
        const nudges = orderIds.length
            ? await nudgeRepo.find({ where: { orderId: In(orderIds) } })
            : [];
        const nudgeByOrderId = new Map(nudges.map(nudge => [nudge.orderId, nudge]));
        const now = new Date();
        for (const order of orders) {
            const existing = nudgeByOrderId.get(String(order.id)) ?? undefined;
            const decision = this.processOrder(order, config, existing, now);
            if (!decision) {
                continue;
            }
            const phone = resolveOrderPhone(order);
            if (!phone) {
                continue;
            }
            const stage = config.stages[decision.stageToSend - 1];
            const sent = await this.msg91.sendAbandonedCartWhatsapp({
                phone,
                templateName: stage.templateName,
                language: stage.language,
                vars: resolveBodyVars(order, stage.bodyVars),
                headerImageUrl: stage.headerImageUrl,
                buttonUrlValue: stage.buttonUrlParam,
            });
            if (sent) {
                // Record the channel actually being swept (not order.channels[0]).
                decision.row.channelId = String(ctx.channelId);
                await nudgeRepo.save(decision.row);
                await this.recordSentEvent(ctx, order, decision.stageToSend, stage.templateName);
            }
        }
    }

    /** Logs one analytics `sent` event. Only the automated sweep calls this — test sends are
     * intentionally excluded so analytics reflect the real funnel. */
    private async recordSentEvent(ctx: RequestContext, order: Order, stage: number, templateName: string): Promise<void> {
        const repo = this.connection.getRepository(ctx, AbandonedCartEvent);
        await repo.save(
            new AbandonedCartEvent({
                orderId: String(order.id),
                channelId: String(ctx.channelId),
                eventType: 'sent',
                stage,
                templateName,
                orderTotalMinor: null,
                cartCreatedAt: new Date(order.createdAt),
                occurredAt: new Date(),
            }),
        );
    }

    /**
     * Logs a `converted` event when a previously-nudged order is placed. The conversion stage is
     * the number of messages already sent to that cart (nudge.stagesSent). Idempotent: a cart with
     * no nudge row, or one already recorded as converted, is skipped. Called from the
     * OrderPlacedEvent subscriber wired in the plugin.
     */
    async recordConversion(ctx: RequestContext, order: Order): Promise<void> {
        const nudge = await this.connection
            .getRepository(ctx, AbandonedCartNudge)
            .findOne({ where: { orderId: String(order.id) } });
        if (!nudge) {
            return;
        }
        const eventRepo = this.connection.getRepository(ctx, AbandonedCartEvent);
        const already = await eventRepo.findOne({ where: { orderId: String(order.id), eventType: 'converted' } });
        const decision = decideConversionEvent({
            hasNudge: true,
            stagesSent: nudge.stagesSent,
            alreadyConverted: Boolean(already),
        });
        if (!decision) {
            return;
        }
        await eventRepo.save(
            new AbandonedCartEvent({
                orderId: String(order.id),
                channelId: String(nudge.channelId || ctx.channelId),
                eventType: 'converted',
                stage: decision.stage,
                templateName: null,
                orderTotalMinor: order.totalWithTax,
                cartCreatedAt: new Date(order.createdAt),
                occurredAt: order.orderPlacedAt ? new Date(order.orderPlacedAt) : new Date(),
            }),
        );
    }

    /**
     * Channel-scoped analytics summary. Aggregates in SQL (GROUP BY counts, a DISTINCT-cart count,
     * and an AVG time-to-order) so cost stays flat as the append-only event log grows, then assembles
     * the result with the pure, unit-tested {@link assembleAnalytics}.
     */
    async readAnalytics(ctx: RequestContext): Promise<AbandonedCartAnalytics> {
        const config = await this.readConfig(ctx);
        const repo = this.connection.getRepository(ctx, AbandonedCartEvent);
        const channelId = String(ctx.channelId);
        const countRows = await repo
            .createQueryBuilder('e')
            .select('e.eventType', 'eventType')
            .addSelect('e.stage', 'stage')
            .addSelect('COUNT(*)', 'count')
            .where('e.channelId = :channelId', { channelId })
            .groupBy('e.eventType')
            .addGroupBy('e.stage')
            .getRawMany();
        const distinctRow = await repo
            .createQueryBuilder('e')
            .select('COUNT(DISTINCT e.orderId)', 'n')
            .where('e.channelId = :channelId AND e.eventType = :type', { channelId, type: 'sent' })
            .getRawOne();
        const convertedAgg = await repo
            .createQueryBuilder('e')
            .select('AVG(TIMESTAMPDIFF(SECOND, e.cartCreatedAt, e.occurredAt))', 'avg')
            .addSelect('SUM(e.orderTotalMinor)', 'revenue')
            .where('e.channelId = :channelId AND e.eventType = :type', { channelId, type: 'converted' })
            .getRawOne();
        return assembleAnalytics({
            rows: countRows.map(r => ({ eventType: r.eventType, stage: Number(r.stage), count: Number(r.count) })),
            distinctNudgedCarts: Number(distinctRow?.n ?? 0),
            avgTimeToOrderSeconds: Number(convertedAgg?.avg ?? 0),
            revenueRecoveredMinor: Number(convertedAgg?.revenue ?? 0),
            costPerMessageMinor: config.costPerMessageMinor,
        });
    }

    /** Count of AddingItems orders in this channel that would be nudged right now (preview). */
    async countEligible(ctx: RequestContext): Promise<number> {
        const config = await this.readConfig(ctx);
        const orderRepo = this.connection.getRepository(ctx, Order);
        const orders = await orderRepo.find({
            where: { state: 'AddingItems' as any },
            relations: { customer: true, channels: true },
        });
        return orders.filter(
            order =>
                order.channels?.some(channel => String(channel.id) === String(ctx.channelId)) &&
                isCartEligible({
                    state: order.state as unknown as string,
                    phoneNumber: resolveOrderPhone(order),
                    totalWithTax: order.totalWithTax,
                    minOrderValueMinor: config.minOrderValueMinor,
                }),
        ).length;
    }

    /**
     * Test helper: send one stage's template to a specific order's customer, bypassing the
     * timing/eligibility/dedupe rules of the sweep. Returns whether MSG91 accepted the send.
     */
    async sendTestNudge(ctx: RequestContext, orderId: ID, stage: number): Promise<boolean> {
        const config = await this.readConfig(ctx);
        if (stage < 1 || stage > config.stages.length) {
            throw new Error(`stage must be between 1 and ${config.stages.length}`);
        }
        const order = await this.connection
            .getRepository(ctx, Order)
            .findOne({ where: { id: orderId }, relations: { customer: true } });
        if (!order) {
            throw new Error(`order ${orderId} not found`);
        }
        const phone = resolveOrderPhone(order);
        if (!phone) {
            throw new Error(`order ${orderId} customer has no phone number`);
        }
        const selected = config.stages[stage - 1];
        return this.msg91.sendAbandonedCartWhatsapp({
            phone,
            templateName: selected.templateName,
            language: selected.language,
            vars: resolveBodyVars(order, selected.bodyVars),
            headerImageUrl: selected.headerImageUrl,
            buttonUrlValue: selected.buttonUrlParam,
        });
    }

    /**
     * Test helper: send one stage's template to a SINGLE explicit phone number, using sample
     * token values (no order/customer lookup). Guarantees exactly one recipient — for isolated
     * testing without touching real customer data or triggering the sweep.
     */
    async sendTestToPhone(ctx: RequestContext, phone: string, stage: number): Promise<boolean> {
        const config = await this.readConfig(ctx);
        if (stage < 1 || stage > config.stages.length) {
            throw new Error(`stage must be between 1 and ${config.stages.length}`);
        }
        const selected = config.stages[stage - 1];
        if (!selected.templateName.trim()) {
            throw new Error(`stage ${stage} has no templateName configured`);
        }
        const sampleOrder = {
            code: 'TEST-0001',
            totalWithTax: 0,
            customer: { firstName: 'Test', lastName: 'User' },
        } as unknown as Order;
        return this.msg91.sendAbandonedCartWhatsapp({
            phone,
            templateName: selected.templateName,
            language: selected.language,
            vars: resolveBodyVars(sampleOrder, selected.bodyVars),
            headerImageUrl: selected.headerImageUrl,
            buttonUrlValue: selected.buttonUrlParam,
        });
    }
}

import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import {
    CacheService,
    RequestContext,
    RequestContextService,
    TransactionalConnection,
    FulfillmentService,
    PaymentMethod,
    Logger,
    ID,
    ProcessContext,
    isGraphQlErrorResult,
} from '@vendure/core';
import { getRazorpayConfig, RazorpayConfig } from '../../../Payment/Razorpay/utils/config-helper';
import { getRazorpayInstance } from '../../../Payment/Razorpay/utils/razorpay-utils';
import QRCode from 'qrcode';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { DELIVERY_REPORT_TAG } from './delivery-report.service';

const loggerCtx = 'DeliveryQrCodeService';

/** QR code expiry in seconds (15 minutes) */
const QR_EXPIRY_SECONDS = 900;

/** Background sweep interval: check for missed QR payments every 5 minutes */
const QR_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Max consecutive sweep failures before auto-closing a stale QR */
const MAX_SWEEP_FAILURES = 5;
const sweepFailureCounts = new Map<number, number>();

/** Minimum interval between QR generations for the same fulfillment (ms) */
const QR_GENERATION_COOLDOWN_MS = 5000;
const qrGenerationTimestamps = new Map<string, number>();

/**
 * Generate a local QR code PNG data URI from a UPI URI string.
 * Result: a ~2-3KB PNG data URI that triggers UPI payment when scanned.
 */
export async function generateQrDataUrl(upiUri: string): Promise<string> {
    return QRCode.toDataURL(upiUri, {
        type: 'image/png',
        width: 300,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#FFFFFF' },
    });
}

/**
 * Extract the UPI URI from a Razorpay QR code response.
 *
 * Priority:
 *   1. `image_content` field (instant, requires `qr_image_content` feature enabled
 *      on Razorpay account — contact Razorpay support to enable)
 *   2. Fallback: fetch Razorpay's QR image → decode with jsQR → extract UPI URI
 *      (adds 400-1500ms latency, depends on Razorpay CDN)
 */
export async function extractUpiUri(qrCodeResponse: any): Promise<string> {
    // Fast path: image_content available (qr_image_content feature enabled)
    if (qrCodeResponse.image_content) {
        Logger.info(`UPI URI from image_content (fast path): ${qrCodeResponse.image_content}`, loggerCtx);
        return qrCodeResponse.image_content;
    }
    // Slow path: fetch image → decode → extract UPI URI
    const razorpayImageUrl = qrCodeResponse.image_url;
    if (!razorpayImageUrl) {
        throw new Error('No image_url or image_content in QR code response');
    }
    const imageUrl = razorpayImageUrl.replace(/^http:\/\//i, 'https://');
    let imageBuffer: Buffer | null = null;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetch(imageUrl, {
                redirect: 'follow',
                signal: AbortSignal.timeout(15000),
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            imageBuffer = Buffer.from(await response.arrayBuffer());
            if (imageBuffer.byteLength === 0) {
                throw new Error('Empty response');
            }
            break;
        } catch (err: any) {
            Logger.warn(`Razorpay QR image fetch attempt ${attempt}/${maxAttempts} failed: ${err.message}`, loggerCtx);
            if (attempt === maxAttempts) {
                throw new Error(`Failed to fetch Razorpay QR image after ${maxAttempts} attempts: ${err.message}`);
            }
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    const { data: pixelData, info } = await sharp(imageBuffer!)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const decoded = jsQR(
        new Uint8ClampedArray(pixelData.buffer),
        info.width,
        info.height,
    );
    if (!decoded || !decoded.data) {
        throw new Error('Could not decode QR content from Razorpay image');
    }
    Logger.info(`UPI URI decoded from image (slow path): ${decoded.data}`, loggerCtx);
    return decoded.data;
}

export interface DeliveryQrCodeResult {
    qrCodeId: string;
    imageUrl: string;
    amount: number;
    cashAmount: number;
    status: string;
    closesAt: string | null;
}

@Injectable()
export class DeliveryQrCodeService implements OnApplicationBootstrap, OnApplicationShutdown {
    private sweepTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private connection: TransactionalConnection,
        private fulfillmentService: FulfillmentService,
        private requestContextService: RequestContextService,
        private processContext: ProcessContext,
        private cacheService: CacheService,
    ) {}

    /**
     * Start the background sweep that catches missed QR payments.
     *
     * Why this is needed:
     *   1. The delivery partner may leave the QR screen before the customer
     *      pays → client-side polling stops → payment is never detected.
     *   2. The Razorpay `qr_code.credited` webhook may not be configured,
     *      may fail silently, or may be delayed.
     *
     * Only the worker process schedules the sweep — the server process also
     * loads this plugin but must not duplicate work.
     */
    onApplicationBootstrap(): void {
        if (!this.processContext.isWorker) {
            return;
        }
        this.sweepTimer = setInterval(() => {
            this.sweepActiveQrCodes().catch(err => {
                const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
                Logger.error(`QR sweep error: ${errMsg}`, loggerCtx);
            });
        }, QR_SWEEP_INTERVAL_MS);
        Logger.info(`QR payment sweep started (interval: ${QR_SWEEP_INTERVAL_MS / 1000}s)`, loggerCtx);
    }

    onApplicationShutdown(): void {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
    }

    /**
     * Find all fulfillments with active QR codes and check if any have been
     * paid on Razorpay but not processed on our side.
     *
     * Two pre-steps avoid wasted Razorpay calls:
     *   1. Close QRs older than QR_EXPIRY_SECONDS in a single batch UPDATE.
     *      Razorpay's `close_by` has already fired; further polling is useless.
     *   2. DISTINCT on `f.id` — a fulfillment with N lines × M channel rows
     *      would otherwise return N*M duplicate rows and trigger N*M identical
     *      Razorpay API calls per sweep run.
     */
    private async sweepActiveQrCodes(): Promise<void> {
        const ctx = await this.requestContextService.create({ apiType: 'admin' });
        // Pre-step: close QRs that have exceeded their Razorpay close_by window.
        // Using `updatedAt` as a proxy for QR creation time — safe because the
        // QR generation path is the last customFields write before expiry.
        const staleCutoff = new Date(Date.now() - QR_EXPIRY_SECONDS * 1000);
        const closed = await this.connection.getRepository(ctx, 'Fulfillment')
            .createQueryBuilder()
            .update()
            .set({ customFields: { qrCodeStatus: 'expired' } } as any)
            .where('customFieldsQrcodestatus = :status', { status: 'active' })
            .andWhere('customFieldsQrcodeid IS NOT NULL')
            .andWhere('updatedAt < :cutoff', { cutoff: staleCutoff })
            .execute();
        if (closed.affected && closed.affected > 0) {
            Logger.info(
                `QR sweep: auto-expired ${closed.affected} stale QR(s) (> ${QR_EXPIRY_SECONDS}s old)`,
                loggerCtx,
            );
        }
        // Find active QRs + resolve channel token. GROUP BY f.id collapses the
        // order-line × channel cartesian to one row per fulfillment; MIN(ch.token)
        // picks any single sub-channel token (orders belong to one sub-channel).
        const rows = await this.connection.getRepository(ctx, 'Fulfillment')
            .createQueryBuilder('f')
            .innerJoin('f.lines', 'fl')
            .innerJoin('fl.orderLine', 'ol')
            .innerJoin('ol.order', 'o')
            .innerJoin('o.channels', 'ch')
            .select('f.id', 'fulfillmentId')
            .addSelect('f.customFieldsQrcodeid', 'qrCodeId')
            .addSelect('MIN(ch.token)', 'channelToken')
            .where('f.customFieldsQrcodestatus = :status', { status: 'active' })
            .andWhere('f.customFieldsQrcodeid IS NOT NULL')
            .andWhere('f.state = :state', { state: 'OutforDelivery' })
            .andWhere("ch.code != '__default_channel__'")
            .groupBy('f.id')
            .addGroupBy('f.customFieldsQrcodeid')
            .getRawMany();
        if (rows.length === 0) return;
        Logger.info(`QR sweep: checking ${rows.length} active QR(s)`, loggerCtx);
        for (const row of rows) {
            try {
                if (!row.channelToken) {
                    Logger.warn(`QR sweep: no channel token for fulfillment ${row.fulfillmentId}. Skipping.`, loggerCtx);
                    continue;
                }
                const channelCtx = await this.requestContextService.create({
                    apiType: 'admin',
                    channelOrToken: row.channelToken,
                });
                Logger.info(`QR sweep: checking fulfillment ${row.fulfillmentId} (QR: ${row.qrCodeId}, channel: ${row.channelToken})`, loggerCtx);
                await this.checkQrStatus(channelCtx, row.fulfillmentId);
                sweepFailureCounts.delete(row.fulfillmentId);
            } catch (err: any) {
                const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
                const failCount = (sweepFailureCounts.get(row.fulfillmentId) || 0) + 1;
                sweepFailureCounts.set(row.fulfillmentId, failCount);
                if (failCount >= MAX_SWEEP_FAILURES) {
                    Logger.warn(
                        `QR sweep: fulfillment ${row.fulfillmentId} failed ${failCount} times, marking QR as closed. Last error: ${errMsg}`,
                        loggerCtx,
                    );
                    // Use createQueryBuilder update to bypass channel filtering
                    await this.connection.getRepository(ctx, 'Fulfillment')
                        .createQueryBuilder()
                        .update()
                        .set({ customFields: { qrCodeStatus: 'closed' } } as any)
                        .where('id = :id', { id: row.fulfillmentId })
                        .execute();
                    sweepFailureCounts.delete(row.fulfillmentId);
                } else {
                    Logger.warn(
                        `QR sweep: failed to check fulfillment ${row.fulfillmentId} (attempt ${failCount}/${MAX_SWEEP_FAILURES}): ${errMsg}`,
                        loggerCtx,
                    );
                }
            }
        }
    }

    /**
     * Generate a Razorpay QR code for COD payment collection during delivery.
     * Fulfillment must be in OutforDelivery state. Order must be COD (not paid online).
     * Idempotent: closes any existing active QR before creating a new one.
     *
     * OPTIMIZED: Reuses the fulfillment entity loaded by loadFulfillmentWithOrder()
     * for the QR field save (was: separate repo.findOne() causing a redundant query).
     */
    async generateQrCode(
        ctx: RequestContext,
        input: { fulfillmentId: ID; cashAmount?: number },
    ): Promise<DeliveryQrCodeResult> {
        // Rate-limit: prevent rapid-fire QR generation for the same fulfillment.
        // Delivery partners spam-tap Retry when the QR image is slow to load,
        // creating 10+ orphan QRs on Razorpay in seconds (each costs money).
        const fKey = String(input.fulfillmentId);
        const lastGen = qrGenerationTimestamps.get(fKey) || 0;
        const elapsed = Date.now() - lastGen;
        if (elapsed < QR_GENERATION_COOLDOWN_MS) {
            // Return the existing QR data instead of creating a new one
            const existing = await this.getQrCode(ctx, input.fulfillmentId);
            if (existing && existing.status === 'active') {
                Logger.info(
                    `QR generation throttled for fulfillment ${fKey} (${elapsed}ms since last). Returning existing QR.`,
                    loggerCtx,
                );
                return existing;
            }
        }
        qrGenerationTimestamps.set(fKey, Date.now());

        const { fulfillment, order } = await this.loadFulfillmentWithOrder(ctx, input.fulfillmentId);
        if (fulfillment.state !== 'OutforDelivery') {
            throw new Error(`Fulfillment must be in OutforDelivery state, currently: ${fulfillment.state}`);
        }
        const isOnlinePayment = order.payments?.some(
            (p: any) => p.method === 'razorpay-payment' && (p.state === 'Settled' || p.state === 'Authorized'),
        );
        if (isOnlinePayment) {
            throw new Error('Order was paid online. No QR collection needed.');
        }
        const orderTotal = (order.subTotalWithTax || 0) + (order.shippingWithTax || 0);
        const cashAmount = input.cashAmount ?? 0;
        if (cashAmount < 0) {
            throw new Error('Cash amount cannot be negative');
        }
        if (cashAmount >= orderTotal) {
            throw new Error('Cash amount must be less than order total. Use Cash payment method instead.');
        }
        const qrAmount = orderTotal - cashAmount;
        // Close existing active QR if any (idempotent regeneration)
        if (fulfillment.customFields?.qrCodeId && fulfillment.customFields?.qrCodeStatus === 'active') {
            await this.closeQrCodeOnRazorpay(ctx, fulfillment.customFields.qrCodeId);
        }
        // Get Razorpay config + SDK instance for this channel
        const razorpayConfig = await this.getRazorpayConfigForChannel(ctx);
        const razorpay = getRazorpayInstance({ key_id: razorpayConfig.key_id, key_secret: razorpayConfig.key_secret });
        const closeBy = Math.floor(Date.now() / 1000) + QR_EXPIRY_SECONDS;
        // Create a Razorpay order so the order code appears in the QR Codes dashboard
        const rzpOrder = await razorpay.orders.create({
            amount: qrAmount,
            currency: 'INR',
            receipt: order.code,
            notes: {
                fulfillmentId: String(input.fulfillmentId),
                orderCode: order.code,
                source: 'delivery-qr',
            },
        } as any);
        const qrCode = await razorpay.qrCode.create({
            type: 'upi_qr',
            usage: 'single_use',
            fixed_amount: true,
            payment_amount: qrAmount,
            order_id: rzpOrder.id,
            description: `Order #${order.code} - Delivery Payment`,
            close_by: closeBy,
            notes: {
                fulfillmentId: String(input.fulfillmentId),
                orderId: String(order.id),
                orderCode: order.code,
                cashAmount: String(cashAmount),
            },
        } as any);
        Logger.info(
            `Generated QR ${qrCode.id} for fulfillment ${input.fulfillmentId}: ₹${qrAmount / 100} (cash: ₹${cashAmount / 100}), order=${rzpOrder.id}`,
            loggerCtx,
        );
        // Extract UPI URI from the QR code response.
        // Fast path: uses `image_content` if qr_image_content feature is enabled.
        // Slow path: fetches Razorpay's QR image and decodes it.
        let imageDataUrl: string;
        try {
            const upiUri = await extractUpiUri(qrCode);
            imageDataUrl = await generateQrDataUrl(upiUri);
        } catch (err: any) {
            Logger.error(
                `QR ${qrCode.id}: failed to generate QR image; closing orphan. ${err.message}`,
                loggerCtx,
            );
            await this.closeQrCodeOnRazorpay(ctx, qrCode.id);
            throw new Error(`Could not generate QR code. Please retry. (${err.message})`);
        }
        // Save QR fields — reuse the already-loaded fulfillment entity (no extra findOne).
        // If the DB save fails after Razorpay successfully created the QR, we have an
        // orphan: the QR is active on Razorpay but unknown to our system. Close it on
        // Razorpay before propagating the error so we don't leak active single-use QRs.
        fulfillment.customFields.qrCodeId = qrCode.id;
        fulfillment.customFields.qrCodeImageUrl = imageDataUrl;
        fulfillment.customFields.qrCodeStatus = 'active';
        fulfillment.customFields.qrCashAmount = cashAmount;
        fulfillment.customFields.qrAmount = qrAmount;
        fulfillment.customFields.qrRazorpayOrderId = rzpOrder.id;
        try {
            await this.connection.getRepository(ctx, 'Fulfillment').save(fulfillment);
        } catch (err: any) {
            Logger.error(
                `QR ${qrCode.id} created on Razorpay but DB save failed; closing orphan. ${err.message}`,
                loggerCtx,
            );
            await this.closeQrCodeOnRazorpay(ctx, qrCode.id);
            throw new Error(`Failed to persist QR code. Please retry. (${err.message})`);
        }
        return {
            qrCodeId: qrCode.id,
            imageUrl: imageDataUrl,
            amount: qrAmount,
            cashAmount,
            status: 'active',
            closesAt: new Date(closeBy * 1000).toISOString(),
        };
    }

    /**
     * Check QR payment status via Razorpay API (polling fallback).
     * If paid, auto-transitions fulfillment to Delivered.
     */
    async checkQrStatus(ctx: RequestContext, fulfillmentId: ID): Promise<DeliveryQrCodeResult> {
        const repo = this.connection.getRepository(ctx, 'Fulfillment');
        const fulfillment = await repo.findOne({ where: { id: fulfillmentId } }) as any;
        if (!fulfillment) {
            throw new Error(`Fulfillment ${fulfillmentId} not found`);
        }
        const qrCodeId = fulfillment.customFields?.qrCodeId;
        if (!qrCodeId) {
            throw new Error('No QR code found for this fulfillment');
        }
        Logger.info(`checkQrStatus: fulfillment=${fulfillmentId}, qrCodeId=${qrCodeId}, status=${fulfillment.customFields?.qrCodeStatus}`, loggerCtx);
        if (fulfillment.customFields?.qrCodeStatus === 'paid') {
            return this.buildQrResult(fulfillment);
        }
        // Razorpay's qrCode.fetch() API is broken for this account (returns "QR doesn't exist"
        // even for valid QRs). Use the Orders API as a workaround: check if the Razorpay order
        // linked to the QR has received a payment.
        const rzpOrderId = fulfillment.customFields?.qrRazorpayOrderId;
        if (!rzpOrderId) {
            Logger.warn(`No Razorpay order ID stored for QR ${qrCodeId}. Cannot check status.`, loggerCtx);
            return this.buildQrResult(fulfillment);
        }
        const razorpay = await this.getRazorpayInstanceForChannel(ctx);
        const rzpOrder = await razorpay.orders.fetch(rzpOrderId) as any;
        const expectedAmount = fulfillment.customFields?.qrAmount || 0;
        Logger.info(
            `QR ${qrCodeId} order check: order_status=${rzpOrder.status}, amount_paid=${rzpOrder.amount_paid}, expected=${expectedAmount}`,
            loggerCtx,
        );
        if (rzpOrder.status === 'paid' || (rzpOrder.amount_paid && rzpOrder.amount_paid >= expectedAmount)) {
            // Order is paid — fetch the payment ID for the delivery record
            let paymentId = rzpOrder.id;
            try {
                const payments = await razorpay.orders.fetchPayments(rzpOrderId) as any;
                const capturedPayment = payments.items?.find((p: any) => p.status === 'captured');
                if (capturedPayment) {
                    paymentId = capturedPayment.id;
                }
            } catch (e: any) {
                Logger.warn(`Could not fetch payments for order ${rzpOrderId}: ${e.message}`, loggerCtx);
            }
            Logger.info(`QR ${qrCodeId} paid via order ${rzpOrderId}. Auto-transitioning fulfillment ${fulfillmentId} to Delivered.`, loggerCtx);
            await this.completeQrDelivery(ctx, fulfillment, paymentId);
            fulfillment.customFields.qrCodeStatus = 'paid';
        } else if (rzpOrder.status === 'created' || rzpOrder.status === 'attempted') {
            // Order not yet paid — still waiting
            Logger.debug(`QR ${qrCodeId} order ${rzpOrderId}: still ${rzpOrder.status}`, loggerCtx);
        }
        return this.buildQrResult(fulfillment);
    }

    /**
     * Close/cancel an active QR code. Use when customer decides to pay all-cash.
     */
    async closeQrCode(ctx: RequestContext, fulfillmentId: ID): Promise<DeliveryQrCodeResult> {
        const repo = this.connection.getRepository(ctx, 'Fulfillment');
        const fulfillment = await repo.findOne({ where: { id: fulfillmentId } }) as any;
        if (!fulfillment) {
            throw new Error(`Fulfillment ${fulfillmentId} not found`);
        }
        const qrCodeId = fulfillment.customFields?.qrCodeId;
        if (!qrCodeId) {
            throw new Error('No QR code found for this fulfillment');
        }
        if (fulfillment.customFields?.qrCodeStatus !== 'active') {
            throw new Error(`QR code is already ${fulfillment.customFields?.qrCodeStatus}`);
        }
        await this.closeQrCodeOnRazorpay(ctx, qrCodeId);
        fulfillment.customFields.qrCodeStatus = 'closed';
        fulfillment.customFields.qrCashAmount = null;
        fulfillment.customFields.qrAmount = null;
        await repo.save(fulfillment);
        Logger.info(`Closed QR ${qrCodeId} for fulfillment ${fulfillmentId}`, loggerCtx);
        return this.buildQrResult(fulfillment);
    }

    /**
     * Get current QR code data for a fulfillment (read-only).
     */
    async getQrCode(ctx: RequestContext, fulfillmentId: ID): Promise<DeliveryQrCodeResult | null> {
        const repo = this.connection.getRepository(ctx, 'Fulfillment');
        const fulfillment = await repo.findOne({ where: { id: fulfillmentId } }) as any;
        if (!fulfillment?.customFields?.qrCodeId) {
            return null;
        }
        return this.buildQrResult(fulfillment);
    }

    /**
     * Handle QR payment webhook from Razorpay (qr_code.credited event).
     * Called from RazorpayWebhookService.
     */
    async handleQrWebhook(
        ctx: RequestContext,
        qrCodeId: string,
        razorpayPaymentId: string,
        amount: number,
    ): Promise<void> {
        const repo = this.connection.getRepository(ctx, 'Fulfillment');
        const fulfillment = await repo
            .createQueryBuilder('f')
            .where('f.customFieldsQrcodeid = :qrCodeId', { qrCodeId })
            .getOne() as any;
        if (!fulfillment) {
            Logger.warn(`QR webhook: No fulfillment found for QR ${qrCodeId}`, loggerCtx);
            return;
        }
        if (fulfillment.customFields?.qrCodeStatus !== 'active') {
            Logger.info(`QR webhook: Fulfillment ${fulfillment.id} QR already ${fulfillment.customFields?.qrCodeStatus}. Skipping.`, loggerCtx);
            return;
        }
        const qrAmount = fulfillment.customFields?.qrAmount || 0;
        if (amount < qrAmount) {
            Logger.warn(
                `QR webhook: Payment amount ${amount} less than QR amount ${qrAmount} for fulfillment ${fulfillment.id}`,
                loggerCtx,
            );
        }
        Logger.info(`QR webhook: Payment confirmed for fulfillment ${fulfillment.id}. Auto-delivering.`, loggerCtx);
        await this.completeQrDelivery(ctx, fulfillment, razorpayPaymentId);
    }

    // ─── Private helpers ───

    /**
     * Complete delivery after QR payment is confirmed.
     * Records payment collection and transitions fulfillment to Delivered.
     *
     * Uses load-then-save to properly persist custom fields via TypeORM
     * entity manager. createQueryBuilder().update().set() does NOT map
     * customFields dot-notation to actual database columns.
     */
    private async completeQrDelivery(
        ctx: RequestContext,
        fulfillment: any,
        razorpayPaymentId: string,
    ): Promise<void> {
        // Lightweight raw query: only need order totals
        const orderData = await this.connection
            .getRepository(ctx, 'Fulfillment')
            .createQueryBuilder('f')
            .innerJoin('f.lines', 'fl')
            .innerJoin('fl.orderLine', 'ol')
            .innerJoin('ol.order', 'o')
            .select('o.subTotalWithTax', 'subTotalWithTax')
            .addSelect('o.shippingWithTax', 'shippingWithTax')
            .where('f.id = :id', { id: fulfillment.id })
            .limit(1)
            .getRawOne();
        if (!orderData) {
            throw new Error(`Could not find order for fulfillment ${fulfillment.id}`);
        }
        const orderTotal = (parseInt(orderData.subTotalWithTax, 10) || 0)
            + (parseInt(orderData.shippingWithTax, 10) || 0);
        const cashAmount = fulfillment.customFields?.qrCashAmount || 0;
        const qrAmount = fulfillment.customFields?.qrAmount || 0;
        const collectionMethod = cashAmount > 0 ? 'Cash+QR' : 'QR';
        const noteParts: string[] = [];
        if (cashAmount > 0) {
            noteParts.push(`Cash: Rs.${(cashAmount / 100).toFixed(2)}`);
        }
        noteParts.push(`QR: Rs.${(qrAmount / 100).toFixed(2)} (${razorpayPaymentId})`);
        // Load-then-save to properly persist custom fields
        const repo = this.connection.getRepository(ctx, 'Fulfillment');
        const entity = await repo.findOne({ where: { id: fulfillment.id } }) as any;
        if (!entity) {
            throw new Error(`Fulfillment ${fulfillment.id} not found`);
        }
        entity.customFields = {
            ...entity.customFields,
            paymentCollectionMethod: collectionMethod,
            collectedAmount: orderTotal,
            collectionNote: noteParts.join(', '),
            deliveredAt: new Date(),
            qrCodeStatus: 'paid',
        };
        await repo.save(entity);
        // Transition fulfillment to Delivered (subscriber auto-transitions order)
        try {
            const result = await this.fulfillmentService.transitionToState(ctx, fulfillment.id, 'Delivered' as any);
            if (isGraphQlErrorResult(result)) {
                throw new Error((result as any).message || 'Failed to transition fulfillment to Delivered');
            }
            Logger.info(`Fulfillment ${fulfillment.id} auto-delivered after QR payment ${razorpayPaymentId}`, loggerCtx);
            await this.cacheService.invalidateTags([DELIVERY_REPORT_TAG]);
        } catch (e: any) {
            Logger.error(`Failed to auto-deliver fulfillment ${fulfillment.id}: ${e.message}`, loggerCtx);
            throw e;
        }
    }

    /**
     * Load fulfillment with order + payments for validation.
     * Used only by generateQrCode() which needs both fulfillment state and order details.
     */
    private async loadFulfillmentWithOrder(ctx: RequestContext, fulfillmentId: ID) {
        const fulfillment = await this.connection
            .getRepository(ctx, 'Fulfillment')
            .createQueryBuilder('f')
            .leftJoinAndSelect('f.lines', 'fl')
            .leftJoinAndSelect('fl.orderLine', 'ol')
            .leftJoinAndSelect('ol.order', 'o')
            .leftJoinAndSelect('o.payments', 'p')
            .where('f.id = :id', { id: fulfillmentId })
            .getOne() as any;
        if (!fulfillment) {
            throw new Error(`Fulfillment ${fulfillmentId} not found`);
        }
        const order = fulfillment.lines?.[0]?.orderLine?.order;
        if (!order) {
            throw new Error(`Could not find order for fulfillment ${fulfillmentId}`);
        }
        return { fulfillment, order };
    }

    /**
     * Get Razorpay SDK instance using the channel's PaymentMethod config.
     */
    private async getRazorpayConfigForChannel(ctx: RequestContext): Promise<RazorpayConfig> {
        const paymentMethod = await this.connection
            .getRepository(ctx, PaymentMethod)
            .createQueryBuilder('pm')
            .leftJoin('pm.channels', 'ch')
            .where('pm.code = :code', { code: 'razorpay-payment' })
            .andWhere('ch.id = :channelId', { channelId: ctx.channelId })
            .getOne();
        if (!paymentMethod) {
            throw new Error(`Razorpay payment method not found for channel (channelId: ${ctx.channelId})`);
        }
        const config = getRazorpayConfig(paymentMethod);
        if (!config) {
            throw new Error(`Razorpay configuration not found (PM id: ${paymentMethod.id}, code: ${paymentMethod.code})`);
        }
        Logger.info(
            `Razorpay config: PM id=${paymentMethod.id}, key=${config.key_id.substring(0, 12)}***, channelId=${ctx.channelId}`,
            loggerCtx,
        );
        return config;
    }

    private async getRazorpayInstanceForChannel(ctx: RequestContext) {
        const config = await this.getRazorpayConfigForChannel(ctx);
        return getRazorpayInstance({ key_id: config.key_id, key_secret: config.key_secret });
    }

    /**
     * Close a QR code on Razorpay. Silently handles "already closed" errors.
     */
    private async closeQrCodeOnRazorpay(ctx: RequestContext, qrCodeId: string): Promise<void> {
        try {
            const razorpay = await this.getRazorpayInstanceForChannel(ctx);
            await razorpay.qrCode.close(qrCodeId);
            Logger.info(`Closed QR ${qrCodeId} on Razorpay`, loggerCtx);
        } catch (e: any) {
            Logger.warn(`Could not close QR ${qrCodeId} on Razorpay (may already be closed): ${e.message}`, loggerCtx);
        }
    }

    /**
     * Build the GraphQL response from fulfillment custom fields.
     */
    private buildQrResult(fulfillment: any): DeliveryQrCodeResult {
        return {
            qrCodeId: fulfillment.customFields?.qrCodeId || '',
            imageUrl: fulfillment.customFields?.qrCodeImageUrl || '',
            amount: fulfillment.customFields?.qrAmount || 0,
            cashAmount: fulfillment.customFields?.qrCashAmount || 0,
            status: fulfillment.customFields?.qrCodeStatus || 'unknown',
            closesAt: null,
        };
    }
}

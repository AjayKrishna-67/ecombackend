import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
    AuthenticatedSession,
    EntityHydrator,
    EventBus,
    Fulfillment,
    ID,
    Logger,
    Order,
    OrderPlacedEvent,
    OrderService,
    OrderStateTransitionEvent,
    RequestContext,
    TransactionalConnection,
    TranslatorService,
} from '@vendure/core';

import { TakeAwayOrderSnapshotService } from '../../../Shipping/take-away/take-away-order-snapshot.service';
import { InvoiceNumberService } from '../../invoice-number/invoice-number.service';
import { ReportStorageService } from '../../scheduled-availability/services/report-storage.service';
import { OrderWhatsappService } from '../../shipping-method-sms-template/services/order-whatsapp.service';
import { loggerCtx, STRATEGY_WHATSAPP, WHATSAPP_ORDER_WINDOW_MS } from '../constants';
import { buildDeliveryBill } from '../functions/delivery-bill';
import { buildInvoiceSummary, isPaidOnline } from '../functions/invoice-summary';
import { WhatsappOrderTemplates } from '../types';
import { DeliveryBillPdfService } from './delivery-bill-pdf.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { displayPhone, WhatsappService } from './whatsapp.service';

declare module '@vendure/core/dist/entity/custom-entity-fields' {
    interface CustomOrderFields {
        placedViaWhatsapp?: boolean;
        /** Registered by TakeAwayPlugin; written by TakeAwayOrderSnapshotService. */
        pickupAddress?: string | null;
        pickupLatitude?: number | null;
        pickupLongitude?: number | null;
        pickupMapUrl?: string | null;
    }
}

/** Bare 10-digit mobile, the format WhatsApp logins store in customer.phoneNumber. */
const INDIAN_MOBILE = /^\d{10}$/;
/**
 * Everything buildInvoiceSummary and buildDeliveryBill read. OrderService.findOne
 * only translates the variants (which sets `name` and the localName custom
 * field) when the list holds 'lines.productVariant' itself, and needs the
 * translations loaded to do it. It never translates the shipping method, so
 * renderInvoice does that from its translations.
 */
const INVOICE_RELATIONS = [
    'customer',
    'customer.user',
    'lines.productVariant',
    'lines.productVariant.translations',
    'lines.productVariant.product',
    'shippingLines.shippingMethod',
    'shippingLines.shippingMethod.translations',
    'surcharges',
    'payments',
    'promotions',
] as const;

/**
 * Sends an "order placed" WhatsApp message, then the pickup branch's location
 * if it is a take-away order, then the invoice PDF — and later when it is out
 * for delivery (with the rider), delivered or cancelled. Only for orders
 * the customer placed after arriving through our WhatsApp login link.
 *
 * Meta allows free-form messages only within 24h of the customer's last
 * message. For a brand with `templates`, an update sent later than
 * WHATSAPP_ORDER_WINDOW_MS after the customer's latest WhatsApp login goes out
 * as an approved MSG91 template instead: the invoice (as the template's
 * document header, which also tells them the order was placed), out for
 * delivery and delivered. There is no cancellation template, so a late
 * cancellation is not messaged.
 *
 * The WhatsApp session is only visible while the customer is in the request.
 * Razorpay can place the order later from its webhook or the reconciliation
 * task, where there is no customer session, so the order is flagged
 * (customFields.placedViaWhatsapp) on every checkout transition the customer
 * makes, and the flag is what OrderPlacedEvent reads.
 */
@Injectable()
export class WhatsappOrderService implements OnApplicationBootstrap {
    constructor(
        private readonly eventBus: EventBus,
        private readonly connection: TransactionalConnection,
        private readonly orderService: OrderService,
        private readonly entityHydrator: EntityHydrator,
        private readonly whatsappService: WhatsappService,
        private readonly invoiceNumberService: InvoiceNumberService,
        private readonly invoicePdfService: InvoicePdfService,
        private readonly deliveryBillPdfService: DeliveryBillPdfService,
        private readonly translator: TranslatorService,
        private readonly takeAwaySnapshotService: TakeAwayOrderSnapshotService,
        private readonly orderWhatsappService: OrderWhatsappService,
        private readonly reportStorage: ReportStorageService,
    ) {}

    onApplicationBootstrap(): void {
        this.eventBus.ofType(OrderStateTransitionEvent).subscribe(event => {
            this.markIfFromWhatsapp(event.ctx, event.order).catch(err =>
                Logger.error(`Flagging order ${event.order.code} failed: ${errorMessage(err)}`, loggerCtx),
            );
            // OutforDelivery is a custom state (delivery-strategy-router), not in OrderState.
            const toState = event.toState as string;
            if (toState === 'OutforDelivery' || toState === 'Delivered' || toState === 'Cancelled') {
                this.notifyOutcome(event.ctx, event.order, toState).catch(err =>
                    Logger.error(`${toState} message for ${event.order.code} failed: ${errorMessage(err)}`, loggerCtx),
                );
            }
        });
        this.eventBus.ofType(OrderPlacedEvent).subscribe(event => {
            this.confirmIfFromWhatsapp(event.ctx, event.order).catch(err =>
                Logger.error(`Order confirmation for ${event.order.code} failed: ${errorMessage(err)}`, loggerCtx),
            );
        });
    }

    async markIfFromWhatsapp(ctx: RequestContext, order: Order): Promise<void> {
        if (order.customFields.placedViaWhatsapp || !(await this.isWhatsappLogin(ctx))) {
            return;
        }
        await this.orderService.updateCustomFields(ctx, order.id, { placedViaWhatsapp: true });
    }

    /**
     * Also checks the live session, not just the flag: when the order is placed
     * in the same request as its first checkout transition, the flag write from
     * markIfFromWhatsapp may not have landed yet.
     */
    async confirmIfFromWhatsapp(ctx: RequestContext, order: Order): Promise<void> {
        if (!order.customFields.placedViaWhatsapp && !(await this.isWhatsappLogin(ctx))) {
            return;
        }
        await this.entityHydrator.hydrate(ctx, order, { relations: ['customer', 'customer.user'] });
        const to = whatsappRecipient(order);
        if (!to) {
            return;
        }
        const templates = this.lateTemplates();
        if (templates && !(await this.isWindowOpen(ctx, order))) {
            await this.sendInvoiceTemplate(ctx, order, to, templates.invoice);
            return;
        }
        await this.whatsappService.sendOrderPlaced({
            to,
            name: order.customer?.firstName ?? '',
            orderCode: order.code,
            total: new Intl.NumberFormat('en-IN', { style: 'currency', currency: order.currencyCode }).format(
                order.totalWithTax / 100,
            ),
        });
        Logger.info(`Sent WhatsApp order confirmation for ${order.code}`, loggerCtx);
        // A missing pickup location must not cost the customer their invoice.
        await this.sendPickupLocation(ctx, order, to).catch(err =>
            Logger.error(`Pickup location for ${order.code} failed: ${errorMessage(err)}`, loggerCtx),
        );
        await this.sendInvoice(ctx, order, to);
    }

    /**
     * Out for delivery, delivered or cancelled. Admin/rider/webhook context, so only the flag
     * decides; the order is re-read for its payments and the take-away and
     * cancellation-reason fields. An order that was never placed (a WhatsApp
     * cart abandoned and cleaned up) is skipped — the customer never ordered.
     * A take-away order is never "out for delivery", so it gets no such message.
     * PartiallyDelivered → OutforDelivery sends it again, for the remaining items.
     */
    async notifyOutcome(
        ctx: RequestContext,
        changed: Order,
        outcome: 'OutforDelivery' | 'Delivered' | 'Cancelled',
    ): Promise<void> {
        if (!changed.customFields.placedViaWhatsapp || !changed.orderPlacedAt) {
            return;
        }
        const order = await this.orderService.findOne(ctx, changed.id, ['customer', 'customer.user', 'payments']);
        const to = order ? whatsappRecipient(order) : null;
        if (!order || !to) {
            return;
        }
        if (outcome === 'OutforDelivery' && order.customFields.isTakeAway) {
            return;
        }
        const name = order.customer?.firstName ?? '';
        const templates = this.lateTemplates();
        const late = !!templates && !(await this.isWindowOpen(ctx, order));
        if (templates && late) {
            await this.sendOutcomeTemplate(ctx, order, to, outcome, templates);
        } else {
            await this.sendOutcomeMessage(ctx, order, to, name, outcome);
        }
        if (outcome === 'Delivered') {
            await this.sendRateApp(order, to, name, late);
        }
    }

    private async sendOutcomeMessage(
        ctx: RequestContext,
        order: Order,
        to: string,
        name: string,
        outcome: 'OutforDelivery' | 'Delivered' | 'Cancelled',
    ): Promise<void> {
        if (outcome === 'OutforDelivery') {
            const rider = await this.findRider(ctx, order.id);
            await this.whatsappService.sendOrderOutForDelivery({
                to,
                name,
                orderCode: order.code,
                partnerName: rider.name,
                partnerPhone: rider.phone,
            });
        } else if (outcome === 'Delivered') {
            await this.whatsappService.sendOrderDelivered({
                to,
                name,
                orderCode: order.code,
                isTakeaway: !!order.customFields.isTakeAway,
            });
        } else {
            await this.whatsappService.sendOrderCancelled({
                to,
                name,
                orderCode: order.code,
                reason: order.customFields.cancellationReason?.trim() ?? '',
                paidOnline: isPaidOnline(order),
            });
        }
        Logger.info(`Sent WhatsApp ${outcome.toLowerCase()} message for ${order.code}`, loggerCtx);
    }

    /**
     * The rider on the order's latest live fulfillment: our own fleet records
     * deliveryPerson*, Adloggs records adloggsRider* (from its webhook, saved
     * before it moves the fulfillment on). Empty when no rider is recorded.
     */
    private async findRider(ctx: RequestContext, orderId: ID): Promise<{ name: string; phone: string }> {
        const fulfillment = await this.connection
            .getRepository(ctx, Fulfillment)
            .createQueryBuilder('f')
            .innerJoin('f.lines', 'fl')
            .innerJoin('fl.orderLine', 'ol')
            .where('ol.orderId = :orderId', { orderId })
            .andWhere("f.state != 'Cancelled'")
            .orderBy('f.createdAt', 'DESC')
            .getOne();
        const fields = (fulfillment?.customFields ?? {}) as Record<string, string | null | undefined>;
        return {
            name: (fields.deliveryPersonName || fields.adloggsRiderName || '').trim(),
            phone: fields.deliveryPersonPhone || fields.adloggsRiderPhone || '',
        };
    }

    /**
     * Take-away only: the exact branch the customer collects from.
     * TakeAwayOrderSnapshotService copies the store location onto the order on
     * this same OrderPlacedEvent, in a parallel subscriber; running it here
     * first (it is idempotent) means this message — and the invoice, which
     * prints "Takeaway" — never race it. The order is then re-read to see the
     * result.
     */
    private async sendPickupLocation(ctx: RequestContext, placed: Order, to: string): Promise<void> {
        await this.takeAwaySnapshotService.snapshotIfTakeAway(ctx, placed);
        const order = await this.orderService.findOne(ctx, placed.id, []);
        const mapUrl = order?.customFields.isTakeAway ? pickupMapLink(order) : null;
        if (!mapUrl) {
            return;
        }
        await this.whatsappService.sendPickupPoint({
            to,
            storeName: this.whatsappService.sellerName,
            address: order?.customFields.pickupAddress ?? '',
            mapUrl,
        });
        Logger.info(`Sent WhatsApp pickup location for ${placed.code}`, loggerCtx);
    }

    /**
     * Free-form invoice PDF. A brand with templates sends it over MSG91, which
     * only takes a public link, so the PDF is published first; if MSG91 refuses
     * the document, the invoice template carries the same link instead, so the
     * customer still gets it.
     */
    private async sendInvoice(ctx: RequestContext, placed: Order, to: string): Promise<void> {
        const rendered = await this.renderInvoice(ctx, placed);
        if (!rendered) {
            return;
        }
        const { order, invoiceNo, pdf, filename } = rendered;
        const templates = this.lateTemplates();
        const url = templates ? await this.publishInvoice(order, pdf) : undefined;
        const caption = `Invoice ${invoiceNo} for order ${order.code}`;
        const sent = await this.whatsappService.sendPdf(to, pdf, filename, caption, url);
        if (sent) {
            Logger.info(`Sent WhatsApp invoice ${invoiceNo} for ${order.code}`, loggerCtx);
        } else if (templates && url) {
            Logger.warn(`Free-form invoice for ${order.code} refused; sending the invoice template`, loggerCtx);
            await this.sendInvoiceTemplateFor(order, invoiceNo, to, templates.invoice, url, filename);
        }
    }

    /** Outside the messaging window: the invoice template, which also confirms the order. */
    private async sendInvoiceTemplate(ctx: RequestContext, placed: Order, to: string, template: string): Promise<void> {
        const rendered = await this.renderInvoice(ctx, placed);
        if (!rendered) {
            return;
        }
        const { order, invoiceNo, pdf, filename } = rendered;
        const url = await this.publishInvoice(order, pdf);
        await this.sendInvoiceTemplateFor(order, invoiceNo, to, template, url, filename);
    }

    private async sendInvoiceTemplateFor(
        order: Order,
        invoiceNo: string,
        to: string,
        template: string,
        url: string,
        filename: string,
    ): Promise<void> {
        const sent = await this.orderWhatsappService.send({
            phone: to,
            templateName: template,
            headerDocument: { url, filename },
            bodyValues: [
                templateName(order),
                order.code,
                new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
                    order.totalWithTax / 100,
                ),
            ],
        });
        if (sent) {
            Logger.info(`Sent WhatsApp invoice template ${invoiceNo} for ${order.code}`, loggerCtx);
        }
    }

    /**
     * Out for delivery / delivered as templates. Meta rejects an empty template
     * variable, so a missing rider becomes the brand's own team and number.
     */
    private async sendOutcomeTemplate(
        ctx: RequestContext,
        order: Order,
        to: string,
        outcome: 'OutforDelivery' | 'Delivered' | 'Cancelled',
        templates: WhatsappOrderTemplates,
    ): Promise<void> {
        let sent: boolean;
        if (outcome === 'OutforDelivery') {
            const rider = await this.findRider(ctx, order.id);
            sent = await this.orderWhatsappService.send({
                phone: to,
                templateName: templates.outForDelivery,
                bodyValues: [
                    templateName(order),
                    order.code,
                    rider.name || 'Our delivery team',
                    displayPhone(rider.phone) || this.whatsappService.brand.supportPhone,
                ],
            });
        } else if (outcome === 'Delivered') {
            sent = await this.orderWhatsappService.send({
                phone: to,
                templateName: templates.delivered,
                bodyValues: [templateName(order), order.code],
            });
        } else {
            Logger.info(`No cancellation template; ${order.code} is outside the messaging window, not messaged`, loggerCtx);
            return;
        }
        if (sent) {
            Logger.info(`Sent WhatsApp ${outcome.toLowerCase()} template for ${order.code}`, loggerCtx);
        }
    }

    /**
     * The rating request that follows the delivered message, for a brand with a
     * Play Store app: free-form inside the window, else the rateApp template
     * (skipped when the brand has none). Sent after `delivered` so it arrives
     * second; a failure is logged and never undoes the delivered message.
     */
    private async sendRateApp(order: Order, to: string, name: string, late: boolean): Promise<void> {
        const { playStoreUrl, templates } = this.whatsappService.brand;
        if (!playStoreUrl) {
            return;
        }
        try {
            if (!late) {
                await this.whatsappService.sendRateApp({ to, name, playStoreUrl });
            } else if (templates?.rateApp) {
                const sent = await this.orderWhatsappService.send({
                    phone: to,
                    templateName: templates.rateApp,
                    bodyValues: [templateName(order)],
                    // The template fixes https://play.google.com/ and fills the rest.
                    buttonUrlSuffixes: [urlSuffix(playStoreUrl)],
                });
                if (!sent) {
                    return;
                }
            } else {
                return;
            }
            Logger.info(`Sent WhatsApp rating request for ${order.code}`, loggerCtx);
        } catch (err) {
            Logger.error(`Rating request for ${order.code} failed: ${errorMessage(err)}`, loggerCtx);
        }
    }

    /**
     * InvoiceNumberPlugin numbers the order on this same OrderPlacedEvent, in a
     * parallel subscriber. Calling it here too is safe (it is idempotent and
     * locks the order row) and guarantees the PDF carries the real invoice
     * number rather than falling back to the order code. The order is then
     * re-read so the PDF sees that number. Null for a brand with no seller
     * block (see brands.ts). The seller's layout picks the PDF.
     */
    private async renderInvoice(
        ctx: RequestContext,
        placed: Order,
    ): Promise<{ order: Order; invoiceNo: string; pdf: Buffer; filename: string } | null> {
        const seller = this.whatsappService.brand.invoiceSeller;
        if (!seller) {
            return null;
        }
        await this.invoiceNumberService.assignInvoiceNumber(ctx, placed.id as number);
        const order = await this.orderService.findOne(ctx, placed.id, [...INVOICE_RELATIONS]);
        if (!order) {
            return null;
        }
        for (const line of order.shippingLines ?? []) {
            if (line.shippingMethod?.translations?.length) {
                line.shippingMethod = this.translator.translate(line.shippingMethod, ctx);
            }
        }
        const filename = `Invoice-${order.code}.pdf`;
        if (seller.layout === 'delivery-bill') {
            const bill = buildDeliveryBill(order);
            return { order, invoiceNo: bill.invoiceNo, pdf: await this.deliveryBillPdfService.render(bill, seller), filename };
        }
        const invoice = buildInvoiceSummary(order, seller.name);
        return { order, invoiceNo: invoice.invoiceNo, pdf: await this.invoicePdfService.render(invoice, seller), filename };
    }

    /**
     * MSG91 (and Meta, for a template header) fetch the PDF themselves, so it
     * must be public. The random part keeps the link unguessable — it carries
     * the customer's name, phone and address — and unique, since Meta caches
     * media by URL (see ReportStorageService.publishPdf).
     */
    private publishInvoice(order: Order, pdf: Buffer): Promise<string> {
        return this.reportStorage.publishPdf(
            `invoice-${order.code}-${randomUUID()}.pdf`,
            pdf,
            new Date().toISOString().slice(0, 10),
        );
    }

    /** The brand's templates; set only for a brand that messages orders outside the window. */
    private lateTemplates(): WhatsappOrderTemplates | undefined {
        return this.whatsappService.brand.templates;
    }

    /**
     * True while Meta still allows free-form messages to this customer, judged
     * by their latest WhatsApp login: each login link is issued in reply to a
     * message from them, so the window is at least that old. A customer with no
     * WhatsApp session left (logged out) counts as outside it.
     */
    private async isWindowOpen(ctx: RequestContext, order: Order): Promise<boolean> {
        const userId = order.customer?.user?.id;
        if (!userId) {
            return false;
        }
        const latest = await this.connection.getRepository(ctx, AuthenticatedSession).findOne({
            where: { user: { id: userId }, authenticationStrategy: STRATEGY_WHATSAPP },
            order: { createdAt: 'DESC' },
            select: ['id', 'createdAt'],
        });
        return !!latest && Date.now() - latest.createdAt.getTime() < WHATSAPP_ORDER_WINDOW_MS;
    }

    /**
     * True when this shop request's session was opened by a WhatsApp login link.
     * Without templates it must also be less than WHATSAPP_ORDER_WINDOW_MS old:
     * Vendure sessions last a year, and free-form messages to a customer
     * returning weeks later would be refused. With templates any age counts —
     * the late messages go out as templates.
     */
    private async isWhatsappLogin(ctx: RequestContext): Promise<boolean> {
        const session = ctx.session;
        if (ctx.apiType !== 'shop' || session?.authenticationStrategy !== STRATEGY_WHATSAPP) {
            return false;
        }
        if (this.lateTemplates()) {
            return true;
        }
        const row = await this.connection
            .getRepository(ctx, AuthenticatedSession)
            .findOne({ where: { id: session.id }, select: ['id', 'createdAt'] });
        return !!row && Date.now() - row.createdAt.getTime() < WHATSAPP_ORDER_WINDOW_MS;
    }
}

/** The customer's WhatsApp number, or null (logged) when the order has no usable one. */
function whatsappRecipient(order: Order): string | null {
    const mobile = order.customer?.phoneNumber;
    if (!mobile || !INDIAN_MOBILE.test(mobile)) {
        Logger.warn(`Order ${order.code} came via WhatsApp but has no usable phone; not messaging`, loggerCtx);
        return null;
    }
    return `91${mobile}`;
}

/**
 * Same rule as the storefront's pickup card (storeMapLink in Remix_Storefront
 * app/utils/order-mode.ts): the store's saved map link, else its pinned
 * coordinates — which open that one point, never a search by name.
 */
function pickupMapLink(order: Order): string | null {
    const { pickupMapUrl, pickupLatitude, pickupLongitude } = order.customFields;
    if (pickupMapUrl) {
        return pickupMapUrl;
    }
    if (pickupLatitude != null && pickupLongitude != null) {
        return `https://www.google.com/maps/search/?api=1&query=${pickupLatitude},${pickupLongitude}`;
    }
    return null;
}

/**
 * What a dynamic template button's {{1}} becomes: the link after its origin,
 * e.g. "account/history". The template fixes "https://<origin>/".
 */
function urlSuffix(url: string): string {
    const { pathname, search, hash } = new URL(url);
    return `${pathname}${search}${hash}`.replace(/^\//, '');
}

/** Template greeting name; Meta rejects an empty variable. */
function templateName(order: Order): string {
    return order.customer?.firstName?.trim() || 'there';
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

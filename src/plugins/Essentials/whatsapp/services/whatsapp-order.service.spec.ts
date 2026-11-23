import {
    EntityHydrator,
    EventBus,
    Order,
    OrderService,
    RequestContext,
    TransactionalConnection,
    TranslatorService,
} from '@vendure/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TakeAwayOrderSnapshotService } from '../../../Shipping/take-away/take-away-order-snapshot.service';
import { InvoiceNumberService } from '../../invoice-number/invoice-number.service';
import { ReportStorageService } from '../../scheduled-availability/services/report-storage.service';
import { OrderWhatsappService } from '../../shipping-method-sms-template/services/order-whatsapp.service';
import { WHATSAPP_BRANDS } from '../brands';
import { STRATEGY_WHATSAPP, WHATSAPP_ORDER_WINDOW_MS } from '../constants';
import { DeliveryBillPdfService } from './delivery-bill-pdf.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { WhatsappOrderService } from './whatsapp-order.service';
import { WhatsappService } from './whatsapp.service';

/**
 * SAFETY: WhatsappService, OrderWhatsappService and ReportStorageService are
 * fully mocked, so nothing is sent to Meta or MSG91 and nothing reaches S3.
 */

function ctxWith(opts: { apiType?: string; strategy?: string } = {}): RequestContext {
    return {
        apiType: opts.apiType ?? 'shop',
        session: { id: 7, authenticationStrategy: opts.strategy ?? STRATEGY_WHATSAPP },
    } as unknown as RequestContext;
}

function orderWith(customFields: { placedViaWhatsapp?: boolean } = {}): Order {
    return {
        id: 1,
        code: 'ABC123',
        createdAt: new Date('2026-10-09T10:10:12Z'),
        currencyCode: 'INR',
        totalWithTax: 125000,
        customFields,
        customer: { firstName: 'Sriram', phoneNumber: '8056305724', user: { id: 3 } },
        lines: [
            { quantity: 2, listPrice: 50000, discounts: [], productVariant: { name: 'Chicken Biriyani' } },
            { quantity: 1, listPrice: 25000, discounts: [], productVariant: { name: 'Raita' } },
        ],
    } as unknown as Order;
}

describe('WhatsappOrderService', () => {
    let sessionCreatedAt: Date | null;
    let findOne: ReturnType<typeof vi.fn>;
    let updateCustomFields: ReturnType<typeof vi.fn>;
    let sendOrderPlaced: ReturnType<typeof vi.fn>;
    let sendPdf: ReturnType<typeof vi.fn>;
    /** What the order's latest fulfillment holds (findRider reads it). */
    let fulfillment: { customFields: Record<string, string> } | null;
    let sendOrderOutForDelivery: ReturnType<typeof vi.fn>;
    let sendOrderDelivered: ReturnType<typeof vi.fn>;
    let sendRateApp: ReturnType<typeof vi.fn>;
    let sendOrderCancelled: ReturnType<typeof vi.fn>;
    let sendPickupPoint: ReturnType<typeof vi.fn>;
    let snapshotIfTakeAway: ReturnType<typeof vi.fn>;
    /** Custom fields the re-read order comes back with (what the DB holds after the snapshot). */
    let storedFields: Record<string, unknown>;
    let assignInvoiceNumber: ReturnType<typeof vi.fn>;
    let findOrder: ReturnType<typeof vi.fn>;
    let brand: (typeof WHATSAPP_BRANDS)[string];
    let sendTemplate: ReturnType<typeof vi.fn>;
    let publishPdf: ReturnType<typeof vi.fn>;
    let renderInvoice: ReturnType<typeof vi.fn>;
    let renderBill: ReturnType<typeof vi.fn>;
    let service: WhatsappOrderService;

    beforeEach(() => {
        sessionCreatedAt = new Date(Date.now() - 60_000);
        findOne = vi.fn(async () => (sessionCreatedAt ? { id: 7, createdAt: sessionCreatedAt } : null));
        updateCustomFields = vi.fn().mockResolvedValue(undefined);
        sendOrderPlaced = vi.fn().mockResolvedValue(undefined);
        sendPdf = vi.fn().mockResolvedValue(true);
        sendTemplate = vi.fn().mockResolvedValue(true);
        renderInvoice = vi.fn().mockResolvedValue(Buffer.from('%PDF-invoice'));
        renderBill = vi.fn().mockResolvedValue(Buffer.from('%PDF-bill'));
        publishPdf = vi.fn().mockResolvedValue('https://cdn.kaaikani.co.in/reports/2026-10-09/invoice.pdf');
        fulfillment = null;
        sendOrderOutForDelivery = vi.fn().mockResolvedValue(undefined);
        sendOrderDelivered = vi.fn().mockResolvedValue(undefined);
        sendRateApp = vi.fn().mockResolvedValue(undefined);
        sendOrderCancelled = vi.fn().mockResolvedValue(undefined);
        sendPickupPoint = vi.fn().mockResolvedValue(undefined);
        snapshotIfTakeAway = vi.fn().mockResolvedValue(undefined);
        storedFields = { placedViaWhatsapp: true, invoiceNo: 'S-07|26-27' };
        assignInvoiceNumber = vi.fn().mockResolvedValue(undefined);
        brand = WHATSAPP_BRANDS['star-biryani'];
        findOrder = vi.fn(async () => {
            return orderWith(storedFields);
        });
        service = new WhatsappOrderService(
            {} as EventBus,
            {
                getRepository: () => ({
                    findOne,
                    // the order's latest fulfillment, read for its rider
                    createQueryBuilder: () => {
                        const query = {
                            innerJoin: () => query,
                            where: () => query,
                            andWhere: () => query,
                            orderBy: () => query,
                            getOne: async () => fulfillment,
                        };
                        return query;
                    },
                }),
            } as unknown as TransactionalConnection,
            { updateCustomFields, findOne: findOrder } as unknown as OrderService,
            { hydrate: vi.fn().mockResolvedValue(undefined) } as unknown as EntityHydrator,
            {
                sendOrderPlaced,
                sendPdf,
                sendPickupPoint,
                sendOrderOutForDelivery,
                sendOrderDelivered,
                sendRateApp,
                sendOrderCancelled,
                get brand() {
                    return brand;
                },
                get sellerName() {
                    return brand.invoiceSeller?.name ?? brand.name;
                },
            } as unknown as WhatsappService,
            { assignInvoiceNumber } as unknown as InvoiceNumberService,
            { render: renderInvoice } as unknown as InvoicePdfService,
            { render: renderBill } as unknown as DeliveryBillPdfService,
            { translate: vi.fn((entity: unknown) => entity) } as unknown as TranslatorService,
            { snapshotIfTakeAway } as unknown as TakeAwayOrderSnapshotService,
            { send: sendTemplate } as unknown as OrderWhatsappService,
            { publishPdf } as unknown as ReportStorageService,
        );
    });

    describe('markIfFromWhatsapp', () => {
        it('flags an order checked out from a fresh WhatsApp-login session', async () => {
            await service.markIfFromWhatsapp(ctxWith(), orderWith());
            expect(updateCustomFields).toHaveBeenCalledWith(expect.anything(), 1, { placedViaWhatsapp: true });
        });

        it('does not flag an OTP/password session', async () => {
            await service.markIfFromWhatsapp(ctxWith({ strategy: 'phone_otp' }), orderWith());
            expect(updateCustomFields).not.toHaveBeenCalled();
        });

        it('does not flag an admin-API transition', async () => {
            await service.markIfFromWhatsapp(ctxWith({ apiType: 'admin' }), orderWith());
            expect(updateCustomFields).not.toHaveBeenCalled();
        });

        it('does not flag a WhatsApp session older than the messaging window', async () => {
            sessionCreatedAt = new Date(Date.now() - WHATSAPP_ORDER_WINDOW_MS - 1);
            await service.markIfFromWhatsapp(ctxWith(), orderWith());
            expect(updateCustomFields).not.toHaveBeenCalled();
        });

        it('skips the DB when the order is already flagged', async () => {
            await service.markIfFromWhatsapp(ctxWith(), orderWith({ placedViaWhatsapp: true }));
            expect(findOne).not.toHaveBeenCalled();
            expect(updateCustomFields).not.toHaveBeenCalled();
        });
    });

    describe('confirmIfFromWhatsapp', () => {
        it('confirms a flagged order even without a customer session (Razorpay webhook)', async () => {
            const webhookCtx = { apiType: 'shop', session: undefined } as unknown as RequestContext;
            await service.confirmIfFromWhatsapp(webhookCtx, orderWith({ placedViaWhatsapp: true }));
            expect(sendOrderPlaced).toHaveBeenCalledWith({
                to: '918056305724',
                name: 'Sriram',
                orderCode: 'ABC123',
                total: '₹1,250.00',
            });
        });

        it('confirms an unflagged order placed in the WhatsApp session itself', async () => {
            await service.confirmIfFromWhatsapp(ctxWith(), orderWith());
            expect(sendOrderPlaced).toHaveBeenCalledTimes(1);
        });

        it('sends nothing for an order that did not come via WhatsApp', async () => {
            await service.confirmIfFromWhatsapp(ctxWith({ strategy: 'phone_otp' }), orderWith());
            expect(sendOrderPlaced).not.toHaveBeenCalled();
            expect(sendPdf).not.toHaveBeenCalled();
        });

        it('numbers the order, then sends the invoice PDF after the text', async () => {
            await service.confirmIfFromWhatsapp(ctxWith(), orderWith({ placedViaWhatsapp: true }));
            expect(assignInvoiceNumber).toHaveBeenCalledWith(expect.anything(), 1);
            // The invoice is built from a re-read taken after numbering (the earlier read is the pin's).
            expect(assignInvoiceNumber.mock.invocationCallOrder[0]).toBeLessThan(
                findOrder.mock.invocationCallOrder.at(-1)!,
            );
            expect(sendPdf).toHaveBeenCalledWith(
                '918056305724',
                expect.any(Buffer),
                'Invoice-ABC123.pdf',
                'Invoice S-07|26-27 for order ABC123',
                undefined,
            );
            expect(sendOrderPlaced.mock.invocationCallOrder[0]).toBeLessThan(sendPdf.mock.invocationCallOrder[0]);
        });

        it('sends a take-away customer the exact branch location between the confirmation and the invoice', async () => {
            storedFields = {
                ...storedFields,
                isTakeAway: true,
                pickupLatitude: 12.7904,
                pickupLongitude: 78.7166,
                pickupAddress: '#5, National Highway, Ambur',
            };
            await service.confirmIfFromWhatsapp(ctxWith(), orderWith({ placedViaWhatsapp: true }));
            expect(sendPickupPoint).toHaveBeenCalledWith({
                to: '918056305724',
                storeName: 'Ambur Star Briyani',
                address: '#5, National Highway, Ambur',
                mapUrl: 'https://www.google.com/maps/search/?api=1&query=12.7904,78.7166',
            });
            const [placed, snapshot, pin, pdf] = [sendOrderPlaced, snapshotIfTakeAway, sendPickupPoint, sendPdf].map(
                mock => mock.mock.invocationCallOrder[0],
            );
            expect(placed).toBeLessThan(snapshot);
            expect(snapshot).toBeLessThan(pin);
            expect(pin).toBeLessThan(pdf);
        });

        it('prefers the saved map link of the branch over its coordinates', async () => {
            storedFields = {
                ...storedFields,
                isTakeAway: true,
                pickupLatitude: 12.7904,
                pickupLongitude: 78.7166,
                pickupMapUrl: 'https://maps.app.goo.gl/branch',
            };
            await service.confirmIfFromWhatsapp(ctxWith(), orderWith({ placedViaWhatsapp: true }));
            expect(sendPickupPoint.mock.calls[0][0].mapUrl).toBe('https://maps.app.goo.gl/branch');
        });

        it('sends no invoice PDF for a brand without a seller block, but still confirms', async () => {
            brand = { ...WHATSAPP_BRANDS['star-biryani'], invoiceSeller: undefined };
            await service.confirmIfFromWhatsapp(ctxWith(), orderWith({ placedViaWhatsapp: true }));
            expect(sendOrderPlaced).toHaveBeenCalledTimes(1);
            expect(assignInvoiceNumber).not.toHaveBeenCalled();
            expect(sendPdf).not.toHaveBeenCalled();
        });

        it('sends no pickup location for a delivery order', async () => {
            await service.confirmIfFromWhatsapp(ctxWith(), orderWith({ placedViaWhatsapp: true }));
            expect(sendPickupPoint).not.toHaveBeenCalled();
            expect(sendPdf).toHaveBeenCalledTimes(1);
        });

        it('still sends the invoice when the pickup location fails', async () => {
            snapshotIfTakeAway.mockRejectedValue(new Error('db down'));
            await service.confirmIfFromWhatsapp(ctxWith(), orderWith({ placedViaWhatsapp: true }));
            expect(sendPickupPoint).not.toHaveBeenCalled();
            expect(sendPdf).toHaveBeenCalledTimes(1);
        });

        it('still sends the text when invoice numbering fails', async () => {
            assignInvoiceNumber.mockRejectedValue(new Error('lock timeout'));
            await expect(
                service.confirmIfFromWhatsapp(ctxWith(), orderWith({ placedViaWhatsapp: true })),
            ).rejects.toThrow('lock timeout');
            expect(sendOrderPlaced).toHaveBeenCalledTimes(1);
            expect(sendPdf).not.toHaveBeenCalled();
        });

        it('sends nothing when the customer has no 10-digit mobile', async () => {
            const order = orderWith({ placedViaWhatsapp: true });
            order.customer!.phoneNumber = '';
            await service.confirmIfFromWhatsapp(ctxWith(), order);
            expect(sendOrderPlaced).not.toHaveBeenCalled();
        });
    });

    describe('notifyOutcome', () => {
        const placed = (): Order => {
            const order = orderWith({ placedViaWhatsapp: true });
            (order as { orderPlacedAt?: Date }).orderPlacedAt = new Date();
            return order;
        };
        const admin = () => ctxWith({ apiType: 'admin' });

        it('names our own fleet rider in the out-for-delivery message', async () => {
            fulfillment = { customFields: { deliveryPersonName: 'Ravi Kumar ', deliveryPersonPhone: '9876543210' } };
            await service.notifyOutcome(admin(), placed(), 'OutforDelivery');
            expect(sendOrderOutForDelivery).toHaveBeenCalledWith({
                to: '918056305724',
                name: 'Sriram',
                orderCode: 'ABC123',
                partnerName: 'Ravi Kumar',
                partnerPhone: '9876543210',
            });
        });

        it('names the Adloggs rider in the out-for-delivery message', async () => {
            fulfillment = { customFields: { adloggsRiderName: 'Kumar', adloggsRiderPhone: '9123456780' } };
            await service.notifyOutcome(admin(), placed(), 'OutforDelivery');
            expect(sendOrderOutForDelivery.mock.calls[0][0]).toMatchObject({
                partnerName: 'Kumar',
                partnerPhone: '9123456780',
            });
        });

        it('still sends out-for-delivery when no rider is recorded', async () => {
            await service.notifyOutcome(admin(), placed(), 'OutforDelivery');
            expect(sendOrderOutForDelivery.mock.calls[0][0]).toMatchObject({ partnerName: '', partnerPhone: '' });
        });

        it('sends no out-for-delivery message for a take-away order', async () => {
            storedFields = { ...storedFields, isTakeAway: true };
            await service.notifyOutcome(admin(), placed(), 'OutforDelivery');
            expect(sendOrderOutForDelivery).not.toHaveBeenCalled();
        });

        it('tells a delivery customer their order was delivered', async () => {
            await service.notifyOutcome(admin(), placed(), 'Delivered');
            expect(sendOrderDelivered).toHaveBeenCalledWith({
                to: '918056305724',
                name: 'Sriram',
                orderCode: 'ABC123',
                isTakeaway: false,
            });
        });

        it('sends no rating request for a brand without a Play Store app', async () => {
            await service.notifyOutcome(admin(), placed(), 'Delivered');
            expect(sendOrderDelivered).toHaveBeenCalledTimes(1);
            expect(sendRateApp).not.toHaveBeenCalled();
        });

        it('tells a take-away customer their order was collected', async () => {
            storedFields = { ...storedFields, isTakeAway: true };
            await service.notifyOutcome(admin(), placed(), 'Delivered');
            expect(sendOrderDelivered.mock.calls[0][0].isTakeaway).toBe(true);
        });

        it('passes the cancellation reason and whether the customer paid online', async () => {
            storedFields = { ...storedFields, cancellationReason: '  Ordered by mistake ' };
            findOrder.mockImplementation(async () => ({
                ...orderWith(storedFields),
                payments: [{ method: 'razorpay-payment' }],
            }));
            await service.notifyOutcome(admin(), placed(), 'Cancelled');
            expect(sendOrderCancelled).toHaveBeenCalledWith({
                to: '918056305724',
                name: 'Sriram',
                orderCode: 'ABC123',
                reason: 'Ordered by mistake',
                paidOnline: true,
            });
        });

        it('does not mention a refund for a cash-on-delivery order', async () => {
            findOrder.mockImplementation(async () => ({ ...orderWith(storedFields), payments: [{ method: 'cod' }] }));
            await service.notifyOutcome(admin(), placed(), 'Cancelled');
            expect(sendOrderCancelled.mock.calls[0][0]).toMatchObject({ reason: '', paidOnline: false });
        });

        it('stays silent for a WhatsApp cart that was never placed', async () => {
            await service.notifyOutcome(admin(), orderWith({ placedViaWhatsapp: true }), 'Cancelled');
            expect(sendOrderCancelled).not.toHaveBeenCalled();
        });

        it('stays silent for an order that did not come via WhatsApp', async () => {
            const order = placed();
            order.customFields.placedViaWhatsapp = false;
            await service.notifyOutcome(admin(), order, 'Delivered');
            expect(sendOrderDelivered).not.toHaveBeenCalled();
        });
    });
    describe('a brand with templates (Kaaikani)', () => {
        const placed = (): Order => {
            const order = orderWith({ placedViaWhatsapp: true });
            (order as { orderPlacedAt?: Date }).orderPlacedAt = new Date();
            return order;
        };
        const admin = () => ctxWith({ apiType: 'admin' });
        const outsideWindow = () => {
            sessionCreatedAt = new Date(Date.now() - WHATSAPP_ORDER_WINDOW_MS - 1);
        };

        beforeEach(() => {
            brand = WHATSAPP_BRANDS.kaaikani;
        });

        it('flags an order from a WhatsApp login of any age', async () => {
            outsideWindow();
            await service.markIfFromWhatsapp(ctxWith(), orderWith());
            expect(updateCustomFields).toHaveBeenCalledWith(expect.anything(), 1, { placedViaWhatsapp: true });
        });

        it('renders the delivery-dashboard bill, not the storefront invoice', async () => {
            await service.confirmIfFromWhatsapp(ctxWith(), orderWith({ placedViaWhatsapp: true }));
            expect(renderInvoice).not.toHaveBeenCalled();
            expect(renderBill).toHaveBeenCalledWith(
                expect.objectContaining({ invoiceNo: 'S-07|26-27', orderCode: 'ABC123' }),
                WHATSAPP_BRANDS.kaaikani.invoiceSeller,
            );
            expect(publishPdf.mock.calls[0][1]).toEqual(Buffer.from('%PDF-bill'));
        });

        it('inside the window: free-form confirmation, then the invoice PDF by its public link', async () => {
            await service.confirmIfFromWhatsapp(ctxWith(), orderWith({ placedViaWhatsapp: true }));
            expect(sendOrderPlaced).toHaveBeenCalledTimes(1);
            expect(publishPdf.mock.calls[0][0]).toMatch(/^invoice-ABC123-[0-9a-f-]{36}\.pdf$/);
            expect(sendPdf).toHaveBeenCalledWith(
                '918056305724',
                expect.any(Buffer),
                'Invoice-ABC123.pdf',
                'Invoice S-07|26-27 for order ABC123',
                'https://cdn.kaaikani.co.in/reports/2026-10-09/invoice.pdf',
            );
            expect(sendTemplate).not.toHaveBeenCalled();
        });

        it('inside the window: falls back to the invoice template when MSG91 refuses the document', async () => {
            sendPdf.mockResolvedValue(false);
            await service.confirmIfFromWhatsapp(ctxWith(), orderWith({ placedViaWhatsapp: true }));
            expect(publishPdf).toHaveBeenCalledTimes(1);
            expect(sendTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    templateName: 'kk_order_invoice',
                    headerDocument: {
                        url: 'https://cdn.kaaikani.co.in/reports/2026-10-09/invoice.pdf',
                        filename: 'Invoice-ABC123.pdf',
                    },
                }),
            );
        });

        it('outside the window: only the invoice template, with the PDF as its header', async () => {
            outsideWindow();
            await service.confirmIfFromWhatsapp(ctxWith(), orderWith({ placedViaWhatsapp: true }));
            expect(sendOrderPlaced).not.toHaveBeenCalled();
            expect(sendPdf).not.toHaveBeenCalled();
            expect(sendTemplate).toHaveBeenCalledWith({
                phone: '918056305724',
                templateName: 'kk_order_invoice',
                headerDocument: {
                    url: 'https://cdn.kaaikani.co.in/reports/2026-10-09/invoice.pdf',
                    filename: 'Invoice-ABC123.pdf',
                },
                bodyValues: ['Sriram', 'ABC123', '1,250.00'],
            });
        });

        it('counts a customer with no WhatsApp session left as outside the window', async () => {
            sessionCreatedAt = null;
            await service.notifyOutcome(admin(), placed(), 'Delivered');
            expect(sendOrderDelivered).not.toHaveBeenCalled();
            expect(sendTemplate).toHaveBeenCalledWith({
                phone: '918056305724',
                templateName: 'kk_order_delivered',
                bodyValues: ['Sriram', 'ABC123'],
            });
        });

        it('inside the window: the delivered message, then the rating request as its own message', async () => {
            await service.notifyOutcome(admin(), placed(), 'Delivered');
            expect(sendRateApp).toHaveBeenCalledWith({
                to: '918056305724',
                name: 'Sriram',
                playStoreUrl: 'https://play.google.com/store/apps/details?id=com.kaaikani.kaaikani&showAllReviews=true',
            });
            expect(sendOrderDelivered.mock.invocationCallOrder[0]).toBeLessThan(sendRateApp.mock.invocationCallOrder[0]);
            expect(sendTemplate).not.toHaveBeenCalled();
        });

        it('outside the window: the delivered template, then the rating template with the Play Store link', async () => {
            outsideWindow();
            await service.notifyOutcome(admin(), placed(), 'Delivered');
            expect(sendRateApp).not.toHaveBeenCalled();
            expect(sendTemplate.mock.calls.map(([args]) => args.templateName)).toEqual([
                'kk_order_delivered',
                'kk_rate_app',
            ]);
            expect(sendTemplate.mock.calls[1][0]).toEqual({
                phone: '918056305724',
                templateName: 'kk_rate_app',
                bodyValues: ['Sriram'],
                // The template fixes https://play.google.com/.
                buttonUrlSuffixes: ['store/apps/details?id=com.kaaikani.kaaikani&showAllReviews=true'],
            });
        });

        it('a failed rating request does not throw out of the delivered notification', async () => {
            sendRateApp.mockRejectedValue(new Error('MSG91 down'));
            await expect(service.notifyOutcome(admin(), placed(), 'Delivered')).resolves.toBeUndefined();
            expect(sendOrderDelivered).toHaveBeenCalledTimes(1);
        });

        it('sends no rating request with out-for-delivery', async () => {
            await service.notifyOutcome(admin(), placed(), 'OutforDelivery');
            expect(sendRateApp).not.toHaveBeenCalled();
        });

        it('inside the window: free-form out-for-delivery, no template', async () => {
            await service.notifyOutcome(admin(), placed(), 'OutforDelivery');
            expect(sendOrderOutForDelivery).toHaveBeenCalledTimes(1);
            expect(sendTemplate).not.toHaveBeenCalled();
        });

        it('outside the window: out-for-delivery template with the rider', async () => {
            outsideWindow();
            fulfillment = { customFields: { deliveryPersonName: 'Ravi Kumar', deliveryPersonPhone: '9876543210' } };
            await service.notifyOutcome(admin(), placed(), 'OutforDelivery');
            expect(sendOrderOutForDelivery).not.toHaveBeenCalled();
            expect(sendTemplate).toHaveBeenCalledWith({
                phone: '918056305724',
                templateName: 'kk_order_out_for_delivery',
                bodyValues: ['Sriram', 'ABC123', 'Ravi Kumar', '+91 98765 43210'],
            });
        });

        it('outside the window: fills a missing rider and name, since Meta rejects empty variables', async () => {
            outsideWindow();
            storedFields = { ...storedFields };
            findOrder.mockImplementation(async () => {
                const order = orderWith(storedFields);
                order.customer!.firstName = '';
                return order;
            });
            await service.notifyOutcome(admin(), placed(), 'OutforDelivery');
            expect(sendTemplate.mock.calls[0][0].bodyValues).toEqual([
                'there',
                'ABC123',
                'Our delivery team',
                '1800 309 4983',
            ]);
        });

        it('outside the window: no cancellation message (there is no template for it)', async () => {
            outsideWindow();
            await service.notifyOutcome(admin(), placed(), 'Cancelled');
            expect(sendOrderCancelled).not.toHaveBeenCalled();
            expect(sendTemplate).not.toHaveBeenCalled();
        });

        it('still skips out-for-delivery for a take-away order', async () => {
            outsideWindow();
            storedFields = { ...storedFields, isTakeAway: true };
            await service.notifyOutcome(admin(), placed(), 'OutforDelivery');
            expect(sendTemplate).not.toHaveBeenCalled();
        });
    });
});

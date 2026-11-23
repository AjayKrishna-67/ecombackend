import { Order } from '@vendure/core';
import { describe, expect, it } from 'vitest';

import { buildInvoiceSummary } from './invoice-summary';

/** Two lines, a ₹40 free-delivery waiver, a ₹50 coupon and a ₹20 loyalty discount. */
function sampleOrder(overrides: Record<string, unknown> = {}): Order {
    return {
        code: 'ABC123',
        orderPlacedAt: new Date('2026-09-30T12:55:50Z'),
        createdAt: new Date('2026-09-30T12:50:00Z'),
        customFields: { invoiceNo: 'S-07|26-27', isTakeAway: false, loyaltyPointsUsed: 20 },
        customer: { firstName: 'Sriram', lastName: 'S' },
        shippingAddress: {
            fullName: 'Sriram S',
            phoneNumber: '8056305724',
            streetLine1: '12 Main Rd',
            city: 'Ambur',
            postalCode: '635802',
        },
        lines: [
            {
                quantity: 2,
                unitPriceWithTax: 25000,
                discountedUnitPriceWithTax: 22500,
                linePriceWithTax: 50000,
                discountedLinePriceWithTax: 45000,
                taxRate: 5,
                lineTax: 2143,
                productVariant: { name: 'Chicken Biriyani', product: { customFields: { hsnCode: '996331' } } },
            },
            {
                quantity: 1,
                unitPriceWithTax: 3000,
                discountedUnitPriceWithTax: 3000,
                linePriceWithTax: 3000,
                discountedLinePriceWithTax: 3000,
                taxRate: 0,
                lineTax: 0,
                productVariant: { name: 'Raita', product: { customFields: {} } },
            },
        ],
        shippingWithTax: 0,
        shippingLines: [{ priceWithTax: 4000, shippingMethod: { name: 'Home Delivery' } }],
        surcharges: [{ price: -2000 }],
        couponCodes: ['OFFER50'],
        promotions: [{ name: 'offer50' }],
        payments: [{ method: 'razorpay-payment' }],
        totalQuantity: 3,
        // 45000 + 3000 + 0 shipping − 2000 loyalty − 5000 coupon
        totalWithTax: 41000,
        ...overrides,
    } as unknown as Order;
}

describe('buildInvoiceSummary', () => {
    it('leaves out lines cancelled down to nothing, such as a removed coupon product', () => {
        const order = sampleOrder();
        const cancelled = {
            quantity: 0,
            unitPriceWithTax: 3900,
            discountedUnitPriceWithTax: 3900,
            linePriceWithTax: 0,
            discountedLinePriceWithTax: 0,
            taxRate: 0,
            lineTax: 0,
            productVariant: { name: 'Small Onion(Small) 250gm', product: { customFields: {} } },
        };
        const invoice = buildInvoiceSummary(
            sampleOrder({ lines: [...(order.lines as unknown[]), cancelled] }),
            'Ambur Star Briyani',
        );

        expect(invoice.lines.map(l => l.quantity)).toEqual([2, 1]);
        expect(invoice).toMatchObject({ subtotal: buildInvoiceSummary(order, 'Ambur Star Briyani').subtotal });
    });

    it('matches the storefront invoice figures', () => {
        const invoice = buildInvoiceSummary(sampleOrder(), 'Ambur Star Briyani');
        expect(invoice).toMatchObject({
            invoiceNo: 'S-07|26-27',
            orderCode: 'ABC123',
            payment: 'Paid online',
            deliveryName: 'Home Delivery',
            billName: 'Sriram S',
            billPhone: '8056305724',
            billAddress: '12 Main Rd, Ambur, 635802',
            subtotal: 48000,
            cgst: 1072,
            sgst: 1071,
            originalShipping: 4000,
            freeDelivery: 4000,
            loyaltyDiscount: 2000,
            couponDiscount: 5000,
            couponLabel: 'OFFER50',
            // 5000 per-line + 5000 coupon + 2000 loyalty + 4000 free delivery
            totalSavings: 16000,
            netTotal: 41000,
        });
        expect(invoice.lines[0]).toEqual({
            name: 'Chicken Biriyani',
            hsn: '996331',
            quantity: 2,
            mrp: 25000,
            rate: 22500,
            taxRate: 5,
            cgst: 1072,
            sgst: 1071,
            amount: 45000,
            save: 5000,
        });
        expect(invoice.lines[1]).toMatchObject({ hsn: '—', taxRate: 0, cgst: 0, sgst: 0, save: 0 });
    });

    it('prints the invoice date in IST', () => {
        expect(buildInvoiceSummary(sampleOrder(), 'X').dateTime).toContain('2026-09-30');
        expect(buildInvoiceSummary(sampleOrder(), 'X').dateTime).toMatch(/6:25:50/);
    });

    it('falls back to the order code when the order has no invoice number yet', () => {
        const order = sampleOrder({ customFields: {} });
        expect(buildInvoiceSummary(order, 'X').invoiceNo).toBe('ABC123');
    });

    it('labels a take-away cash order and bills it to the store', () => {
        const order = sampleOrder({
            customFields: { isTakeAway: true },
            payments: [{ method: 'cash-on-delivery' }],
        });
        const invoice = buildInvoiceSummary(order, 'Ambur Star Briyani');
        expect(invoice.payment).toBe('Pay at the restaurant');
        expect(invoice.billAddress).toBe('Takeaway from Ambur Star Briyani');
    });
});

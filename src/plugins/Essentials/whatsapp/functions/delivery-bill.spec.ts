import { Order } from '@vendure/core';
import { describe, expect, it } from 'vitest';

import { buildDeliveryBill, simplifyDeliveryTime } from './delivery-bill';

interface LineInput {
    qty: number;
    listPrice: number;
    shadowPrice?: number | null;
    taxRate?: number;
    discount?: number;
    localName?: string;
}

function line({ qty, listPrice, shadowPrice = null, taxRate = 0, discount = 0, localName }: LineInput) {
    const withTax = qty * listPrice - discount;
    return {
        quantity: qty,
        listPrice,
        taxRate,
        proratedLinePriceWithTax: withTax,
        proratedLinePrice: Math.round(withTax / (1 + taxRate / 100)),
        discounts: discount
            ? [{ adjustmentSource: 'PROMOTION:5', description: 'OFFER 249', amount: discount, amountWithTax: discount }]
            : [],
        productVariant: {
            name: ' Tomato Nattu - 1 Kg ',
            customFields: { shadowPrice, localName },
            product: { customFields: { hsnCode: '0702' } },
        },
    };
}

function orderWith(overrides: Record<string, unknown> = {}): Order {
    const lines = (overrides.lines as ReturnType<typeof line>[]) ?? [line({ qty: 2, listPrice: 4500, shadowPrice: 60 })];
    const surcharges = (overrides.surcharges as Array<{ description: string; listPrice: number }>) ?? [];
    const subTotalWithTax =
        lines.reduce((total, l) => total + l.proratedLinePriceWithTax, 0) +
        surcharges.reduce((total, s) => total + s.listPrice, 0);
    return {
        code: 'KK1',
        customFields: { invoiceNo: 'M-00412|26-27', otherInstructions: '' },
        orderPlacedAt: new Date('2026-10-09T10:10:12Z'),
        couponCodes: [],
        promotions: [{ id: 5, couponCode: 'OFFER249' }],
        payments: [{ method: 'razorpay-payment', state: 'Settled' }],
        shippingLines: [{ listPrice: 4000, shippingMethod: { name: 'Tomorrow Morning Delivery (Rs.40 incl.Tax)' } }],
        shippingWithTax: 4000,
        shippingAddress: { fullName: 'Priya', phoneNumber: '9876543210', city: 'Madurai', postalCode: '625020', country: 'India' },
        customer: { customFields: { loyaltyPointsAvailable: 140 } },
        subTotalWithTax,
        ...overrides,
        lines,
        surcharges,
    } as unknown as Order;
}

describe('buildDeliveryBill', () => {
    it('leaves out lines cancelled down to nothing, such as a removed coupon product', () => {
        const kept = line({ qty: 2, listPrice: 4500, shadowPrice: 60 });
        const bill = buildDeliveryBill(orderWith({ lines: [kept, line({ qty: 0, listPrice: 3900 })] }));

        expect(bill.lines.map(l => l.quantity)).toEqual([2]);
        expect(bill.totalQuantity).toBe(2);
    });

    it('prices each line at its list rate, with MRP from the variant shadow price in rupees', () => {
        const bill = buildDeliveryBill(orderWith());
        expect(bill.lines[0]).toEqual({
            name: 'Tomato Nattu - 1 Kg',
            localName: '',
            hsn: '0702',
            quantity: 2,
            mrp: 6000,
            rate: 4500,
            taxRate: 0,
            taxAmount: 0,
            amount: 9000,
            save: 3000,
        });
        expect(bill.subtotal).toBe(9000);
    });

    it('prints the catalogue local name under the English one', () => {
        const bill = buildDeliveryBill(orderWith({ lines: [line({ qty: 1, listPrice: 4500, localName: ' தக்காளி ' })] }));
        expect(bill.lines[0].localName).toBe('தக்காளி');
    });

    it('treats a missing shadow price as MRP 0 with no saving', () => {
        const bill = buildDeliveryBill(orderWith({ lines: [line({ qty: 1, listPrice: 4500 })] }));
        expect(bill.lines[0]).toMatchObject({ mrp: 0, save: 0 });
    });

    it('lists the coupon with its code, and loyalty points as their own row', () => {
        const bill = buildDeliveryBill(
            orderWith({
                lines: [line({ qty: 2, listPrice: 4500, discount: 1000 })],
                surcharges: [{ description: 'Loyalty Points Discount', listPrice: -2000 }],
            }),
        );
        expect(bill.discounts).toEqual([
            { description: 'OFFER 249', code: 'OFFER249', amount: 1000 },
            { description: 'Loyalty Points Discount', code: '', amount: 2000 },
        ]);
        // 9000 − 1000 − 2000 + 4000 shipping
        expect(bill.netTotal).toBe(10000);
    });

    it('folds waived shipping into the coupon row and shows Shipping at full price', () => {
        const bill = buildDeliveryBill(
            orderWith({ lines: [line({ qty: 2, listPrice: 4500, discount: 1000 })], shippingWithTax: 0 }),
        );
        expect(bill.discountsIncludeShipping).toBe(true);
        expect(bill.discounts[0].amount).toBe(5000);
        expect(bill.shipping).toBe(4000);
        expect(bill.shippingSaved).toBe(0);
        // Subtotal + Shipping − Discount = Net Total
        expect(bill.subtotal + bill.shipping - bill.discounts[0].amount).toBe(bill.netTotal);
    });

    it('shows a free-shipping saving beside Shipping when no coupon row exists', () => {
        const bill = buildDeliveryBill(orderWith({ shippingWithTax: 0 }));
        expect(bill.shipping).toBe(0);
        expect(bill.shippingSaved).toBe(4000);
        expect(bill.discountsIncludeShipping).toBe(false);
    });

    it('splits the included GST equally into CGST and SGST', () => {
        const bill = buildDeliveryBill(orderWith({ lines: [line({ qty: 1, listPrice: 11200, taxRate: 12 })] }));
        expect(bill.lines[0].taxAmount).toBe(1200);
        expect(bill.cgst).toBe(600);
        expect(bill.sgst).toBe(600);
    });

    it('adds up item, coupon and shipping savings', () => {
        const bill = buildDeliveryBill(
            orderWith({ lines: [line({ qty: 2, listPrice: 4500, shadowPrice: 60, discount: 1000 })], shippingWithTax: 0 }),
        );
        // 3000 MRP saving + 1000 coupon + 4000 shipping
        expect(bill.totalSavings).toBe(8000);
    });

    it('calls a Razorpay payment online and anything else cash on delivery', () => {
        expect(buildDeliveryBill(orderWith()).payment).toBe('Online Payment');
        expect(buildDeliveryBill(orderWith({ payments: [{ method: 'cod', state: 'Authorized' }] })).payment).toBe(
            'Cash on Delivery',
        );
        expect(
            buildDeliveryBill(orderWith({ payments: [{ method: 'razorpay-payment', state: 'Declined' }] })).payment,
        ).toBe('Cash on Delivery');
    });

    it('fills the header fields the dashboard prints', () => {
        const bill = buildDeliveryBill(orderWith({ customFields: { invoiceNo: '', otherInstructions: ' Ring twice ' } }));
        expect(bill).toMatchObject({
            invoiceNo: 'KK1',
            dateTime: '2026-10-09 3:40:12 PM',
            delivery: 'Morning Delivery',
            billAddress: 'Madurai, 625020, India',
            note: 'Ring twice',
            rewardPointsAvailable: 140,
        });
    });
});

describe('simplifyDeliveryTime', () => {
    it('keeps only the slot', () => {
        expect(simplifyDeliveryTime('Tomorrow Evening Delivery (Rs.40 incl.Tax)')).toBe('Evening Delivery');
    });

    it('otherwise strips the price and the leading day', () => {
        expect(simplifyDeliveryTime('Tomorrow Express (Rs.60)')).toBe('Express');
        expect(simplifyDeliveryTime(undefined)).toBe('');
    });
});

import { Order } from '@vendure/core';

declare module '@vendure/core/dist/entity/custom-entity-fields' {
    interface CustomOrderFields {
        /** Registered in vendure-config-custom-fields.ts; set by InvoiceNumberPlugin. */
        invoiceNo?: string | null;
        /** Registered by TakeAwayPlugin. */
        isTakeAway?: boolean;
        /** Registered by CancelOrderPlugin; the customer's reason when they asked to cancel. */
        cancellationReason?: string;
    }
    interface CustomProductFields {
        /** Registered in vendure-config-custom-fields.ts. */
        hsnCode?: string;
    }
}

/** One row of the invoice items table. Money is in paise. */
export interface InvoiceLine {
    name: string;
    hsn: string;
    quantity: number;
    mrp: number;
    rate: number;
    /** GST % on the line, e.g. 5. 0 when the line carries no tax. */
    taxRate: number;
    cgst: number;
    sgst: number;
    amount: number;
    save: number;
}

/** Everything the invoice PDF prints. Money is in paise. */
export interface InvoiceSummary {
    invoiceNo: string;
    orderCode: string;
    /** IST, e.g. "2026-09-30, 6:25:50 p.m." */
    dateTime: string;
    payment: string;
    deliveryName: string;
    isTakeaway: boolean;
    billName: string;
    billPhone: string;
    billAddress: string;
    lines: InvoiceLine[];
    subtotal: number;
    cgst: number;
    sgst: number;
    originalShipping: number;
    freeDelivery: number;
    couponLabel: string;
    couponDiscount: number;
    loyaltyDiscount: number;
    loyaltyPointsUsed: number;
    couponCodes: string[];
    totalQuantity: number;
    totalSavings: number;
    netTotal: number;
}

const CASH_METHOD = /cod|cash|offline/;

/**
 * The same figures the storefront's order-confirmation invoice shows
 * (Remix_Storefront app/routes/checkout.confirmation.$orderCode.tsx), so the
 * PDF sent on WhatsApp matches the one the customer can download. Keep the two
 * in step when either changes.
 *
 * Expects `order` hydrated with customer, lines.productVariant (translated),
 * lines.productVariant.product,
 * shippingLines.shippingMethod, surcharges, payments and promotions.
 */
export function buildInvoiceSummary(order: Order, sellerName: string): InvoiceSummary {
    // A line cancelled down to nothing (Modify order keeps it at quantity 0
    // as the record) is not something the customer bought.
    const lines = order.lines.filter(line => line.quantity > 0).map(toInvoiceLine);
    const subtotal = sum(lines.map(line => line.amount));
    const perLineSavings = sum(lines.map(line => line.save));
    // GST is included in the prices — the CGST/SGST split is informational.
    const totalGst = sum(order.lines.map(line => line.lineTax ?? 0));
    const cgst = Math.round(totalGst / 2);

    // Show the original shipping, so a free-delivery coupon appears as its own
    // line rather than making Shipping read 0.
    const chargedShipping = order.shippingWithTax ?? 0;
    const originalShipping = Math.max(
        sum((order.shippingLines ?? []).map(line => line.priceWithTax ?? 0)),
        chargedShipping,
    );
    const freeDelivery = Math.max(0, originalShipping - chargedShipping);
    // Loyalty points are applied as a negative surcharge.
    const loyaltyDiscount = Math.abs(sum((order.surcharges ?? []).filter(s => s.price < 0).map(s => s.price)));
    const netTotal = order.totalWithTax ?? 0;
    // Order-level coupon discount = the residual that balances to the net total.
    const couponDiscount = Math.max(0, subtotal + chargedShipping - loyaltyDiscount - netTotal);

    const couponCodes = order.couponCodes ?? [];
    const isTakeaway = !!order.customFields.isTakeAway;
    const address = order.shippingAddress ?? {};
    return {
        invoiceNo: order.customFields.invoiceNo || order.code,
        orderCode: order.code,
        dateTime: new Date(order.orderPlacedAt ?? order.createdAt).toLocaleString('en-CA', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
        }),
        payment: paymentLabel(order, isTakeaway),
        deliveryName: order.shippingLines?.[0]?.shippingMethod?.name ?? '',
        isTakeaway,
        billName:
            address.fullName ||
            `${order.customer?.firstName ?? ''} ${order.customer?.lastName ?? ''}`.trim(),
        billPhone: address.phoneNumber ?? '',
        billAddress: isTakeaway
            ? `Takeaway from ${sellerName}`
            : [
                  address.streetLine1,
                  address.streetLine2,
                  address.city,
                  address.province,
                  address.postalCode,
                  address.countryCode,
              ]
                  .filter(Boolean)
                  .join(', '),
        lines,
        subtotal,
        cgst,
        sgst: totalGst - cgst,
        originalShipping,
        freeDelivery,
        couponLabel: couponLabel(couponCodes, (order.promotions ?? []).map(p => p.name)),
        couponDiscount,
        loyaltyDiscount,
        loyaltyPointsUsed: order.customFields.loyaltyPointsUsed ?? 0,
        couponCodes,
        totalQuantity: order.totalQuantity,
        totalSavings: perLineSavings + couponDiscount + loyaltyDiscount + freeDelivery,
        netTotal,
    };
}

function toInvoiceLine(line: Order['lines'][number]): InvoiceLine {
    const mrp = line.unitPriceWithTax ?? 0;
    const amount = line.discountedLinePriceWithTax ?? line.linePriceWithTax ?? 0;
    const taxRate = line.taxRate ?? 0;
    const lineTax = line.lineTax ?? 0;
    const hasTax = taxRate > 0 && lineTax > 0;
    const cgst = hasTax ? Math.round(lineTax / 2) : 0;
    return {
        name: line.productVariant?.name ?? '',
        hsn: line.productVariant?.product?.customFields?.hsnCode || '—',
        quantity: line.quantity,
        mrp,
        rate: line.discountedUnitPriceWithTax ?? mrp,
        taxRate: hasTax ? taxRate : 0,
        cgst,
        sgst: hasTax ? lineTax - cgst : 0,
        amount,
        save: Math.max(0, (line.linePriceWithTax ?? 0) - amount),
    };
}

function paymentLabel(order: Order, isTakeaway: boolean): string {
    if (!order.payments?.length) {
        return '—';
    }
    if (!isPaidOnline(order)) {
        return isTakeaway ? 'Pay at the restaurant' : 'Cash on Delivery';
    }
    return 'Paid online';
}

/** True when the order's payment is an online one (not COD / pay at the store). Needs `payments` loaded. */
export function isPaidOnline(order: Order): boolean {
    const method = order.payments?.[0]?.method;
    return !!method && !CASH_METHOD.test(method.toLowerCase());
}

/**
 * Coupon code and promotion name are often the same string ("OFFER300"), so
 * duplicates are collapsed case-insensitively, keeping the first spelling.
 */
function couponLabel(couponCodes: string[], promotionNames: string[]): string {
    const unique = new Map<string, string>();
    for (const label of [...couponCodes, ...promotionNames]) {
        const trimmed = label?.trim();
        if (trimmed && !unique.has(trimmed.toLowerCase())) {
            unique.set(trimmed.toLowerCase(), trimmed);
        }
    }
    return [...unique.values()].join(' ') || 'Coupon Discount';
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

import { Order } from '@vendure/core';

declare module '@vendure/core/dist/entity/custom-entity-fields' {
    interface CustomProductVariantFields {
        /** Registered in vendure-config-custom-fields.ts. MRP in RUPEES, not paise. */
        shadowPrice?: number | null;
        /** Registered in vendure-config-custom-fields.ts. Tamil (Malayalam on Idukki) name. */
        localName?: string | null;
    }
    interface CustomOrderFields {
        /** Registered by CancelOrderPlugin; the customer's cutting / delivery note. */
        otherInstructions?: string;
    }
}

/** One row of the bill's items table. Money is in paise. */
export interface DeliveryBillLine {
    name: string;
    /** Catalogue localName, printed under the English name; empty when none. */
    localName: string;
    hsn: string;
    quantity: number;
    mrp: number;
    rate: number;
    /** GST % on the line, e.g. 5. */
    taxRate: number;
    /** GST included in the line after discounts. */
    taxAmount: number;
    amount: number;
    save: number;
}

/** A discount row in the totals. Money is in paise. */
export interface DeliveryBillDiscount {
    description: string;
    /** Coupon code of the promotion; empty for loyalty and code-less promotions. */
    code: string;
    amount: number;
}

/** Everything the delivery-bill PDF prints. Money is in paise. */
export interface DeliveryBill {
    invoiceNo: string;
    orderCode: string;
    /** IST, e.g. "2026-10-09 3:40:12 PM". */
    dateTime: string;
    payment: string;
    delivery: string;
    billName: string;
    billPhone: string;
    billAddress: string;
    note: string;
    lines: DeliveryBillLine[];
    couponCodes: string;
    loyaltyPointsUsed: number;
    totalQuantity: number;
    totalSavings: number;
    subtotal: number;
    cgst: number;
    sgst: number;
    /** Shipping as printed: 0 reads "Free". */
    shipping: number;
    /** "(saved X)" beside Shipping; 0 when not shown. */
    shippingSaved: number;
    discounts: DeliveryBillDiscount[];
    /** The first discount row also covers the waived shipping. */
    discountsIncludeShipping: boolean;
    netTotal: number;
    rewardPointsAvailable: number;
}

const ONLINE_METHOD = 'razorpay-payment';
const LOYALTY_SURCHARGE = 'Loyalty Points Discount';

/**
 * The same bill the delivery dashboard prints (Delivery-PWA
 * app/reports/page.tsx buildBillHtml, fed by ReportsPlugin's billPrintReport in
 * orders-report.service.ts), built from one hydrated order instead of report
 * rows. Keep the three in step when any of them changes.
 *
 * Expects `order` hydrated with customer, lines.productVariant (translated),
 * lines.productVariant.product, shippingLines.shippingMethod (translated),
 * surcharges, payments and promotions.
 */
export function buildDeliveryBill(order: Order): DeliveryBill {
    // A line cancelled down to nothing (Modify order keeps it at quantity 0
    // as the record) is not something the customer bought.
    const lines = order.lines.filter(line => line.quantity > 0).map(toBillLine);
    const itemsSavings = sum(lines.map(line => line.save));

    const discounts = billDiscounts(order);
    const discountsSum = sum(discounts.map(d => d.amount));
    const chargedShipping = order.shippingWithTax ?? 0;
    const originalShipping = (order.shippingLines ?? []).length
        ? sum(order.shippingLines.map(line => line.listPrice ?? 0))
        : chargedShipping;
    const shippingSavings = Math.max(0, originalShipping - chargedShipping);
    // A coupon that also waived shipping shows as one row covering both, with
    // Shipping at its full price, so Subtotal + Shipping − Discount = Net Total.
    const discountsIncludeShipping = shippingSavings > 0 && discounts.length > 0;
    if (discountsIncludeShipping) {
        discounts[0] = { ...discounts[0], amount: discounts[0].amount + shippingSavings };
    }

    const totalTax = sum(lines.map(line => line.taxAmount));
    const address = order.shippingAddress ?? {};
    return {
        invoiceNo: order.customFields.invoiceNo || order.code,
        orderCode: order.code,
        dateTime: istDateTime(order.orderPlacedAt ?? order.createdAt),
        payment: isOnline(order) ? 'Online Payment' : 'Cash on Delivery',
        delivery: simplifyDeliveryTime(order.shippingLines?.[0]?.shippingMethod?.name),
        billName: address.fullName ?? '',
        billPhone: address.phoneNumber ?? '',
        billAddress: [address.streetLine1, address.streetLine2, address.city, address.postalCode, address.country ?? address.countryCode]
            .map(part => (part == null ? '' : String(part).trim()))
            .filter(Boolean)
            .join(', '),
        note: order.customFields.otherInstructions?.trim() ?? '',
        lines,
        couponCodes: (order.couponCodes ?? []).join(','),
        loyaltyPointsUsed: order.customFields.loyaltyPointsUsed ?? 0,
        totalQuantity: sum(lines.map(line => line.quantity)),
        totalSavings: itemsSavings + discountsSum + shippingSavings,
        subtotal: sum(lines.map(line => line.amount)),
        cgst: totalTax / 2,
        sgst: totalTax / 2,
        shipping: discountsIncludeShipping ? originalShipping : chargedShipping,
        shippingSaved: discountsIncludeShipping ? 0 : shippingSavings,
        discounts,
        discountsIncludeShipping,
        netTotal: (order.subTotalWithTax ?? 0) + chargedShipping,
        rewardPointsAvailable: order.customer?.customFields?.loyaltyPointsAvailable ?? 0,
    };
}

/** Rate is the unit list price (incl. GST); promotions appear as discount rows, not in the rate. */
function toBillLine(line: Order['lines'][number]): DeliveryBillLine {
    const variant = line.productVariant;
    const rate = line.listPrice ?? 0;
    const amount = line.quantity * rate;
    const mrp = (variant?.customFields?.shadowPrice ?? 0) * 100;
    return {
        name: (variant?.name ?? '').trim(),
        localName: variant?.customFields?.localName?.trim() ?? '',
        hsn: variant?.product?.customFields?.hsnCode ?? '',
        quantity: line.quantity,
        mrp,
        rate,
        taxRate: line.taxRate ?? 0,
        // Prorated, so a coupon spread over the line shrinks the taxable base.
        taxAmount: (line.proratedLinePriceWithTax ?? 0) - (line.proratedLinePrice ?? 0),
        amount,
        save: Math.max(0, mrp * line.quantity - amount),
    };
}

/**
 * Line promotions grouped by source (as Order.discounts groups them, but
 * without shipping promotions — those show on the Shipping row), then the
 * loyalty-points surcharge.
 */
function billDiscounts(order: Order): DeliveryBillDiscount[] {
    const couponCodeById = new Map((order.promotions ?? []).map(p => [String(p.id), p.couponCode ?? '']));
    const grouped = new Map<string, DeliveryBillDiscount>();
    for (const line of order.lines) {
        for (const discount of line.discounts) {
            const existing = grouped.get(discount.adjustmentSource);
            const amount = Math.abs(discount.amountWithTax ?? discount.amount);
            if (existing) {
                existing.amount += amount;
                continue;
            }
            const promotionId = /^PROMOTION:(\d+)$/.exec(discount.adjustmentSource)?.[1];
            grouped.set(discount.adjustmentSource, {
                description: discount.description,
                code: (promotionId && couponCodeById.get(promotionId)) || '',
                amount,
            });
        }
    }
    const loyalty = (order.surcharges ?? [])
        .filter(surcharge => surcharge.description === LOYALTY_SURCHARGE)
        .map(surcharge => ({ description: surcharge.description, code: '', amount: Math.abs(surcharge.listPrice) }));
    return [...grouped.values(), ...loyalty];
}

function isOnline(order: Order): boolean {
    return (order.payments ?? []).some(
        payment => payment.method === ONLINE_METHOD && payment.state !== 'Cancelled' && payment.state !== 'Declined',
    );
}

/** "Tomorrow Morning Delivery (Rs.40 incl.Tax)" → "Morning Delivery". */
export function simplifyDeliveryTime(name: string | null | undefined): string {
    if (!name) {
        return '';
    }
    const slot = /morning|afternoon|evening|night/i.exec(name)?.[0];
    if (slot) {
        return `${slot.charAt(0).toUpperCase()}${slot.slice(1).toLowerCase()} Delivery`;
    }
    return name
        .replace(/\s*\([^)]*\)\s*/g, '')
        .replace(/^(today|tomorrow|same\s*day)\s+/i, '')
        .trim();
}

function istDateTime(date: Date): string {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
        })
            .formatToParts(new Date(date))
            .map(part => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.dayPeriod}`;
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

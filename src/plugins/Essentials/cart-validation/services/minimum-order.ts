/**
 * The channel's minimum order value: customers cannot check out until the
 * cart's product total reaches it. Set per channel in the admin
 * (Channel custom field `minimumOrderAmount`, paise; 0 = no minimum).
 */
export interface MinimumOrderStatus {
    meetsMinimumOrder: boolean;
    /** The channel's minimum in paise; null when it has none. */
    minimumOrderAmount: number | null;
    /** How much more (paise) the cart needs; 0 when the minimum is met. */
    amountToMinimumOrder: number;
    /** What to tell the customer while below the minimum; null when met. */
    minimumOrderMessage: string | null;
}

/** The minimum in paise from a channel; 0 when it has none. */
export function minimumOrderOf(channel: { customFields?: any } | undefined | null): number {
    const value = Number(channel?.customFields?.minimumOrderAmount ?? 0);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** "₹299", "₹1,000", "₹49.50". */
export function formatRupees(paise: number): string {
    const rupees = paise / 100;
    const hasPaise = paise % 100 !== 0;
    return `₹${rupees.toLocaleString('en-IN', {
        minimumFractionDigits: hasPaise ? 2 : 0,
        maximumFractionDigits: hasPaise ? 2 : 0,
    })}`;
}

/**
 * Whether a cart whose product total is [subTotal] (paise, after discounts,
 * before delivery charges) meets the channel minimum [minimum] (paise).
 */
export function minimumOrderStatus(subTotal: number, minimum: number): MinimumOrderStatus {
    if (minimum <= 0) {
        return { meetsMinimumOrder: true, minimumOrderAmount: null, amountToMinimumOrder: 0, minimumOrderMessage: null };
    }
    const missing = Math.max(0, minimum - Math.round(subTotal));
    return {
        meetsMinimumOrder: missing === 0,
        minimumOrderAmount: minimum,
        amountToMinimumOrder: missing,
        minimumOrderMessage:
            missing === 0
                ? null
                : `Add products worth ${formatRupees(missing)} more to checkout. Minimum order value is ${formatRupees(minimum)}.`,
    };
}

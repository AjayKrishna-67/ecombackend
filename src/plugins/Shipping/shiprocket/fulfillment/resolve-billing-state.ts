/**
 * Shiprocket's create-order API requires `billing_state`, but almost no
 * KaaiKani address carries a province — Vendure's address forms leave it blank
 * and the admin draft-order copy does not fill it in either. Refusing to
 * fulfil on that basis blocks the shipment over a field nobody fills.
 *
 * Quick is hyperlocal: pickup and delivery are in the same city by definition,
 * so the pickup warehouse's state is a sound stand-in when the customer's
 * address has none.
 */
export function resolveBillingState(
    orderProvince: string | null | undefined,
    pickupState: string | null | undefined,
): { state: string; fromPickup: boolean } | null {
    const province = (orderProvince ?? '').trim();
    if (province) {
        return { state: province, fromPickup: false };
    }
    const fallback = (pickupState ?? '').trim();
    if (fallback) {
        return { state: fallback, fromPickup: true };
    }
    return null;
}

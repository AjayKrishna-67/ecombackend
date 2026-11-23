import { LanguageCode, ShippingEligibilityChecker } from '@vendure/core';

import { ShiprocketService } from '../services/shiprocket.service';

let service: ShiprocketService;

/**
 * Cheap gate (no API call) so the Shiprocket calculator only runs for relevant orders:
 * the destination must be international (≠ IN, taken from the order's shipping address) and the
 * channel must have a pickup pincode configured.
 */
export const shiprocketEligibilityChecker = new ShippingEligibilityChecker({
    code: 'shiprocket-international-eligibility',
    description: [
        { languageCode: LanguageCode.en, value: 'Shiprocket International (destination eligible)' },
    ],
    args: {},
    init(injector) {
        service = injector.get(ShiprocketService);
    },
    check: async (ctx, order) => {
        const country = order.shippingAddress?.countryCode?.toUpperCase();
        if (!country || country === 'IN') {
            return false;
        }
        const config = await service.getConfig(ctx);
        return Boolean(config.pickupPincode);
    },
});

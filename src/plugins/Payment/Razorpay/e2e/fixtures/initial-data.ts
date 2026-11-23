import { InitialData, LanguageCode } from '@vendure/core';

/**
 * Smallest population for a checkout: one country/zone, a 0% tax rate (so the
 * order total equals the variant price) and one free shipping method, which the
 * AddingItems → ArrangingPayment transition requires. Products and the Razorpay
 * payment method are created by the suite through the Admin API.
 */
export const initialData: InitialData = {
    defaultLanguage: LanguageCode.en,
    defaultZone: 'Asia',
    countries: [{ name: 'India', code: 'IN', zone: 'Asia' }],
    taxRates: [{ name: 'Standard Tax', percentage: 0 }],
    shippingMethods: [{ name: 'Standard Delivery', price: 0 }],
    paymentMethods: [],
    collections: [],
};

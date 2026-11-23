import { InitialData, LanguageCode } from '@vendure/core';

/**
 * Smallest population that lets a Vendure server boot for e2e tests.
 *
 * Deliberately not the sample data shipped with `@vendure/create`: that fixture
 * imports hundreds of products and takes seconds per suite. This plugin's tests
 * create the one product they need through the Admin API, so everything here is
 * simply what the bootstrap refuses to start without.
 */
export const initialData: InitialData = {
    defaultLanguage: LanguageCode.en,
    defaultZone: 'Asia',
    countries: [{ name: 'India', code: 'IN', zone: 'Asia' }],
    taxRates: [{ name: 'Standard Tax', percentage: 0 }],
    shippingMethods: [],
    paymentMethods: [],
    collections: [],
};

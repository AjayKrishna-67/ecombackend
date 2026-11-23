import { ID } from '@vendure/core';

import { ORDER_LINE_PRICE_UPDATED } from './history-entry.constant';

declare module '@vendure/core' {
    interface OrderHistoryEntryData {
        [ORDER_LINE_PRICE_UPDATED]: {
            note: string;
            currencyCode: string;
            changes: Array<{
                orderLineId: ID;
                variantId: ID;
                previousUnitPrice: number;
                newUnitPrice: number;
            }>;
        };
    }
}


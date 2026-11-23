export const ORDER_LINE_PRICE_UPDATED = 'ORDER_LINE_PRICE_UPDATED' as const;

export interface OrderLinePriceEntryChange {
    orderLineId: string;
    variantId: string;
    previousUnitPrice: number;
    newUnitPrice: number;
}

export interface OrderLinePriceHistoryPayload {
    note: string;
    currencyCode: string;
    changes: OrderLinePriceEntryChange[];
}


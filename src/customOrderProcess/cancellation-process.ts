import { OrderProcess, OrderState } from '@vendure/core';

export const cancellationRequestProcess: OrderProcess<OrderState | 'CancellationRequested'> = {
    transitions: {
        PaymentSettled: {
            to: ['CancellationRequested'],
            mergeStrategy: 'merge',
        },
        PaymentAuthorized: {
            to: ['CancellationRequested'],
            mergeStrategy: 'merge',
        },
        // ✅ ADD THIS BLOCK TO ALLOW REVERTING
        CancellationRequested: {
            to: [
                'PaymentSettled',    // Allow going back to Settled (if payment was Settled)
                'Cancelled',         // Allow proceeding to Cancelled
            ],
        },
    } as any,
};
import { graphql } from '@vendure/dashboard';

export const getRazorpayOrderStatusDocument = graphql(`
    query GetRazorpayOrderStatus($orderId: ID!) {
        getRazorpayOrderStatus(orderId: $orderId) {
            status
            attempts
            amountPaid
            amountDue
            razorpayOrderId
            history {
                id
                status
                amount
                method
                createdAt
                errorReason
            }
        }
    }
`);

export const getRazorpayAlertsDocument = graphql(`
    query GetRazorpayAlerts {
        getRazorpayAlerts {
            orderId
            orderCode
            reason
            stuckSince
        }
    }
`);

export interface RazorpayPaymentAttempt {
    id: string;
    status: string;
    amount: number;
    method: string;
    createdAt: string;
    errorReason: string | null;
}

export interface RazorpayOrderStatus {
    status: string;
    attempts: number;
    amountPaid: number;
    amountDue: number;
    razorpayOrderId: string;
    history: RazorpayPaymentAttempt[];
}

export interface RazorpayAlert {
    orderId: string;
    orderCode: string;
    reason: string;
    stuckSince: string;
}

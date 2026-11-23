import { defineDashboardExtension, api } from '@vendure/dashboard';
import React from 'react';
import { PaymentWindowStatus } from './payment-window-status';
import { getRazorpayAlertsDocument, RazorpayAlert } from './queries';
import { RazorpayOrderStatusBlock } from './razorpay-order-status';
import { RazorpayPaymentConfig } from './razorpay-payment-config';
import { RazorpayStatusActionBarButton } from './razorpay-status-dialog';
import { RazorpayWebhookHistoryEntry } from './razorpay-webhook-history';

defineDashboardExtension({
    customFormComponents: {
        customFields: [
            { id: 'razorpay-payment-config', component: RazorpayPaymentConfig },
            { id: 'payment-window-status', component: PaymentWindowStatus },
        ],
    },
    historyEntries: [
        {
            type: 'RAZORPAY_WEBHOOK',
            component: ({ entry }) => <RazorpayWebhookHistoryEntry entry={entry} />,
        },
    ],
    pageBlocks: [
        {
            id: 'razorpay-order-status',
            title: 'Razorpay Payment Status',
            location: {
                pageId: 'order-detail',
                column: 'main',
                position: { blockId: 'order-payments', order: 'after' },
            },
            component: ({ context }) => <RazorpayOrderStatusBlock context={context} />,
            shouldRender: ({ entity }) => !!entity?.customFields?.razorpayOrderId,
        },
    ],
    actionBarItems: [
        {
            pageId: 'order-detail',
            id: 'view-razorpay-status',
            component: ({ context }) => <RazorpayStatusActionBarButton context={context} />,
        },
    ],
    alerts: [
        {
            id: 'razorpay-stuck-orders',
            title: (data: RazorpayAlert[]) =>
                data.length === 1 ? '1 Razorpay order needs attention' : `${data.length} Razorpay orders need attention`,
            description: (data: RazorpayAlert[]) =>
                data.length === 1
                    ? `Order ${data[0].orderCode} stuck: ${data[0].reason}`
                    : `${data.length} orders are stuck in payment.`,
            severity: 'warning',
            check: async (): Promise<RazorpayAlert[]> => {
                const result = await api.query(getRazorpayAlertsDocument, {});
                return ((result as any)?.getRazorpayAlerts as RazorpayAlert[]) ?? [];
            },
            shouldShow: (data) => Array.isArray(data) && data.length > 0,
            recheckInterval: 5 * 60 * 1000,
            actions: [
                {
                    label: 'View order',
                    onClick: ({ data, dismiss }) => {
                        if (Array.isArray(data) && data[0]?.orderId) {
                            window.location.href = `/dashboard/orders/${data[0].orderId}`;
                        }
                        dismiss();
                    },
                },
            ],
        },
    ],
});

import {
    api,
    Badge,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    PageContextValue,
    Skeleton,
} from '@vendure/dashboard';
import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { getRazorpayOrderStatusDocument, RazorpayOrderStatus, RazorpayPaymentAttempt } from './queries';

function formatRupee(paise?: number | null): string {
    return `₹${((paise ?? 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';

function statusVariant(status?: string | null): BadgeVariant {
    const s = (status ?? '').toLowerCase();
    if (s === 'paid' || s === 'captured') return 'success';
    if (s === 'failed') return 'destructive';
    if (s === 'authorized') return 'secondary';
    if (s === 'created' || s === 'attempted') return 'warning';
    return 'outline';
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="border-border flex items-center justify-between border-b py-2 last:border-b-0">
            <span className="text-muted-foreground font-medium">{label}</span>
            <span>{children}</span>
        </div>
    );
}

export function RazorpayOrderStatusBlock({ context }: { context: PageContextValue }) {
    const orderId: string | undefined = context.entity?.id;

    const { data, isLoading, isError, error } = useQuery({
        queryKey: ['razorpay-order-status', orderId],
        queryFn: () => api.query(getRazorpayOrderStatusDocument, { orderId: orderId! }),
        enabled: !!orderId,
    });

    const status: RazorpayOrderStatus | undefined = (data as any)?.getRazorpayOrderStatus;

    return (
        <Card>
            <CardHeader>
                <CardTitle>Razorpay Payment Status</CardTitle>
            </CardHeader>
            <CardContent>
                {isLoading && (
                    <div className="space-y-2">
                        <Skeleton className="h-6 w-full" />
                        <Skeleton className="h-6 w-full" />
                        <Skeleton className="h-6 w-full" />
                        <Skeleton className="h-6 w-3/4" />
                    </div>
                )}

                {isError && (
                    <div className="bg-destructive/10 text-destructive rounded border p-3 text-sm">
                        {((error as Error)?.message ?? '').includes('No Razorpay ID found')
                            ? 'This order does not have a Razorpay payment associated with it.'
                            : ((error as Error)?.message ?? 'Failed to load Razorpay payment status')}
                    </div>
                )}

                {!isLoading && !isError && status && (
                    <>
                        <div className="mb-4">
                            <SummaryRow label="Status">
                                <Badge variant={statusVariant(status.status)} className="text-xs uppercase">
                                    {status.status ?? 'Unknown'}
                                </Badge>
                            </SummaryRow>
                            <SummaryRow label="Payment Attempts">{status.attempts ?? 0}</SummaryRow>
                            <SummaryRow label="Amount Paid">
                                <span className="text-primary font-semibold">{formatRupee(status.amountPaid)}</span>
                            </SummaryRow>
                            <SummaryRow label="Amount Due">
                                <span className="text-primary font-semibold">{formatRupee(status.amountDue)}</span>
                            </SummaryRow>
                            {status.razorpayOrderId && (
                                <SummaryRow label="Razorpay Order ID">
                                    <span className="font-mono text-sm">{status.razorpayOrderId}</span>
                                </SummaryRow>
                            )}
                        </div>

                        {status.history && status.history.length > 0 ? (
                            <div>
                                <h4 className="mb-2 text-sm font-semibold">Payment History</h4>
                                <div className="border-border overflow-x-auto rounded border">
                                    <table className="w-full text-sm">
                                        <thead className="bg-muted/50">
                                            <tr className="text-left">
                                                <th className="p-2 font-medium">Status</th>
                                                <th className="p-2 font-medium">Amount</th>
                                                <th className="p-2 font-medium">Method</th>
                                                <th className="p-2 font-medium">Date</th>
                                                <th className="p-2 font-medium">Error</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {status.history.map((p: RazorpayPaymentAttempt) => (
                                                <tr key={p.id} className="border-border border-t">
                                                    <td className="p-2">
                                                        <Badge variant={statusVariant(p.status)} className="text-xs uppercase">
                                                            {p.status}
                                                        </Badge>
                                                    </td>
                                                    <td className="p-2">{formatRupee(p.amount)}</td>
                                                    <td className="p-2">{p.method ?? 'N/A'}</td>
                                                    <td className="p-2">{new Date(p.createdAt).toLocaleString()}</td>
                                                    <td className="text-destructive p-2 text-xs">{p.errorReason ?? ''}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        ) : (
                            <p className="text-muted-foreground py-3 text-center text-sm italic">
                                No payment attempts recorded.
                            </p>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}

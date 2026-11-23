import {
    api,
    Badge,
    Button,
    Card,
    CardContent,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    PageContextValue,
    Skeleton,
} from '@vendure/dashboard';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Check, Copy, CreditCard, X } from 'lucide-react';
import React, { useState } from 'react';
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

function shouldShowButton(order: any): boolean {
    if (!order?.customFields?.razorpayOrderId) return false;
    if (order?.payments?.length) {
        const codes: string[] = order.payments.map((p: any) => p.method?.code).filter(Boolean);
        if (codes.some((c) => c === 'offline' || c === 'dummy-payment-handler')) return false;
    }
    return true;
}

function PaymentRow({ payment }: { payment: RazorpayPaymentAttempt }) {
    const s = payment.status.toLowerCase();
    const isSuccess = s === 'captured' || s === 'paid';
    const isFail = s === 'failed';
    const iconClasses = isFail
        ? 'bg-destructive/10 text-destructive'
        : isSuccess
        ? 'bg-success/10 text-success'
        : 'bg-muted text-muted-foreground';

    return (
        <Card>
            <CardContent className="p-3">
                <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-1 gap-2.5">
                        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${iconClasses}`}>
                            {isFail ? <X size={16} /> : isSuccess ? <Check size={16} /> : null}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold">Payment {payment.status}</div>
                            <div className="text-muted-foreground text-xs">
                                {new Date(payment.createdAt).toLocaleString()} • {payment.method ?? 'N/A'}
                            </div>
                        </div>
                    </div>
                    <div className="text-sm font-semibold whitespace-nowrap">{formatRupee(payment.amount)}</div>
                </div>
                {payment.errorReason && (
                    <div className="bg-destructive/10 border-destructive text-destructive mt-2.5 flex items-start gap-2 rounded border-l-2 p-2 text-xs">
                        <AlertCircle size={14} className="mt-0.5 shrink-0" />
                        <span>{payment.errorReason}</span>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}

function StatusDialogContent({ orderId }: { orderId: string }) {
    const { data, isLoading, isError, error } = useQuery({
        queryKey: ['razorpay-order-status-dialog', orderId],
        queryFn: () => api.query(getRazorpayOrderStatusDocument, { orderId }),
    });

    const status: RazorpayOrderStatus | undefined = (data as any)?.getRazorpayOrderStatus;

    async function copy(text: string) {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // ignore
        }
    }

    if (isLoading) {
        return (
            <div className="space-y-3 p-4">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
            </div>
        );
    }

    if (isError) {
        const msg = (error as Error)?.message ?? 'Failed to load Razorpay payment status';
        const friendly = msg.includes('No Razorpay ID found')
            ? 'This order does not have a Razorpay payment associated with it.'
            : msg;
        return (
            <div className="bg-destructive/10 text-destructive m-4 rounded border p-3 text-sm">{friendly}</div>
        );
    }

    if (!status) return null;

    return (
        <div className="space-y-4 p-1">
            <div className="bg-muted flex items-center justify-between rounded-lg p-4">
                <div className="text-2xl font-bold">{formatRupee(status.amountPaid)}</div>
                <Badge variant={statusVariant(status.status)} className="text-xs uppercase tracking-wide">
                    {status.status ?? 'UNKNOWN'}
                </Badge>
            </div>

            {status.razorpayOrderId && (
                <div className="border-border space-y-1 border-b pb-3">
                    <div className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
                        Razorpay Order ID
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm break-all">{status.razorpayOrderId}</span>
                        <Button variant="ghost" size="icon" onClick={() => copy(status.razorpayOrderId)} title="Copy">
                            <Copy size={14} />
                        </Button>
                    </div>
                </div>
            )}

            <div className="border-border flex items-center justify-between border-b pb-3">
                <span className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
                    Attempts
                </span>
                <span className="text-sm font-semibold">{status.attempts ?? 0}</span>
            </div>

            {status.history && status.history.length > 0 ? (
                <div className="space-y-2">
                    <h3 className="text-sm font-semibold">Payment History</h3>
                    <div className="space-y-2">
                        {status.history.map((p) => (
                            <PaymentRow key={p.id} payment={p} />
                        ))}
                    </div>
                </div>
            ) : (
                <div className="text-muted-foreground p-4 text-center text-sm">No payment attempts recorded.</div>
            )}
        </div>
    );
}

export function RazorpayStatusActionBarButton({ context }: { context: PageContextValue }) {
    const [open, setOpen] = useState(false);
    const order = context.entity;
    if (!order || !shouldShowButton(order)) return null;

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger
                render={
                    <Button variant="outline" size="sm">
                        <CreditCard size={14} className="mr-1.5" />
                        Razorpay Status
                    </Button>
                }
            />
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>Transaction Details</DialogTitle>
                </DialogHeader>
                {order.id && <StatusDialogContent orderId={String(order.id)} />}
            </DialogContent>
        </Dialog>
    );
}

import { Badge, HistoryEntry, HistoryEntryItem } from '@vendure/dashboard';
import { CloudUpload } from 'lucide-react';
import React from 'react';

interface WebhookData {
    amount?: number;
    status?: string;
    webhookEvent?: string;
    razorpayOrderId?: string;
    paymentId?: string;
}

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';

function statusVariant(status?: string): BadgeVariant {
    const s = (status ?? '').toLowerCase();
    if (s === 'captured' || s === 'paid') return 'success';
    if (s === 'failed') return 'destructive';
    return 'outline';
}

function formatEvent(event?: string): string {
    if (!event) return 'Webhook Processed';
    return event
        .split('.')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

function formatAmount(paise?: number): string {
    return `₹${((paise ?? 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function RazorpayWebhookHistoryEntry({ entry }: { entry: HistoryEntryItem }) {
    const data: WebhookData = entry.data ?? {};
    const isFailure = (data.webhookEvent ?? '').includes('failed');
    const iconClass = isFailure ? 'bg-destructive text-destructive-foreground' : 'bg-success text-success-foreground';

    return (
        <HistoryEntry
            entry={entry}
            title="Razorpay Webhook"
            timelineIcon={<CloudUpload size={14} />}
            timelineIconClassName={iconClass}
            isPrimary={true}
        >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="bg-primary/5 border-primary/20 col-span-full rounded border p-2">
                    <div className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
                        Amount Received
                    </div>
                    <div className="text-primary text-lg font-bold">{formatAmount(data.amount)}</div>
                </div>

                <div>
                    <div className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
                        Current Status
                    </div>
                    <Badge variant={statusVariant(data.status)} className="mt-1 text-xs uppercase">
                        {data.status ?? 'unknown'}
                    </Badge>
                </div>

                <div>
                    <div className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
                        Webhook Event
                    </div>
                    <div className="text-sm">{formatEvent(data.webhookEvent)}</div>
                </div>

                <div className="col-span-full">
                    <div className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
                        Razorpay Order ID
                    </div>
                    <div className="font-mono text-xs break-all">{data.razorpayOrderId ?? '—'}</div>
                </div>
                <div className="col-span-full">
                    <div className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider">
                        Payment ID
                    </div>
                    <div className="font-mono text-xs break-all">{data.paymentId ?? '—'}</div>
                </div>
            </div>
        </HistoryEntry>
    );
}

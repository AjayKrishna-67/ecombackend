import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Button, toast } from '@vendure/dashboard';
import React from 'react';

import {
    adloggsOrderFulfillmentsDocument,
    adloggsWalletBalanceDocument,
    syncAdloggsStatusDocument,
} from './queries';

const STATUS_LABELS: Record<number, string> = {
    2: 'Pending',
    3: 'Assigned',
    11: 'Arrived at pickup',
    4: 'Picked up',
    9: 'Out for delivery',
    8: 'Arrived at delivery',
    5: 'Delivered',
    6: 'Cancelled',
    13: 'Return initiated',
    14: 'RTO delivered',
};

const PROBLEM_STATUSES = [6, 13, 14];
/** Delivered / Cancelled / Return / RTO — nothing further will arrive. */
const TERMINAL_STATUSES = [5, 6, 13, 14];

interface AdloggsFulfillment {
    id: string;
    state: string;
    uuid: string | null;
    statusId: number | null;
    trackUrl: string | null;
    riderName: string | null;
    riderPhone: string | null;
    fee: string | null;
    error: string | null;
}

/**
 * "Adloggs Delivery" card on the order-detail page: status, rider, fee,
 * tracking link and a Sync button (fetches live status / retries a failed
 * creation). Data comes from the fulfillment custom fields, kept current by
 * the Adloggs webhook.
 */
export function OrderAdloggsBlock({ context }: { context: any }) {
    const orderId = context?.entity?.id as string | undefined;
    const queryClient = useQueryClient();
    const queryKey = ['adloggs-order-fulfillments', orderId];

    const detailsQuery = useQuery({
        queryKey,
        queryFn: () => api.query(adloggsOrderFulfillmentsDocument, { id: orderId! }),
        enabled: !!orderId,
        // Webhooks update the fulfillment in the background; poll while any
        // Adloggs delivery on this order is still in progress so the card
        // follows along without pressing Sync. Stops once all are terminal.
        refetchInterval: (query: any) => {
            const list: any[] = (query.state.data as any)?.order?.fulfillments ?? [];
            const live = list.some(
                (f: any) =>
                    (f?.method ?? '').toLowerCase() === 'adloggs' &&
                    f?.customFields?.adloggsOrderUuid &&
                    !TERMINAL_STATUSES.includes(f?.customFields?.adloggsStatus),
            );
            return live ? 15_000 : false;
        },
        refetchOnWindowFocus: true,
    });

    const walletQuery = useQuery({
        queryKey: ['adloggs-wallet'],
        queryFn: () => api.query(adloggsWalletBalanceDocument, {}),
        staleTime: 5 * 60 * 1000,
    });

    const sync = useMutation({
        mutationFn: (fulfillmentId: string) => api.mutate(syncAdloggsStatusDocument, { fulfillmentId }),
        onSuccess: (res: any) => {
            const r = res?.syncAdloggsStatus;
            if (r?.success) {
                toast.success(r.message || 'Synced with Adloggs');
            } else {
                toast.error(r?.message || 'Sync failed');
            }
            queryClient.invalidateQueries({ queryKey });
        },
        onError: (e: any) => toast.error(e?.message ?? 'Sync failed'),
    });

    const fulfillments: AdloggsFulfillment[] = ((detailsQuery.data as any)?.order?.fulfillments ?? [])
        .filter((f: any) => (f?.method ?? '').toLowerCase() === 'adloggs')
        .map((f: any) => ({
            id: f.id,
            state: f.state,
            uuid: f.customFields?.adloggsOrderUuid || null,
            statusId: f.customFields?.adloggsStatus ?? null,
            trackUrl: f.customFields?.adloggsTrackUrl || null,
            riderName: f.customFields?.adloggsRiderName || null,
            riderPhone: f.customFields?.adloggsRiderPhone || null,
            fee: f.customFields?.adloggsFee || null,
            error: f.customFields?.adloggsError || null,
        }));

    if (detailsQuery.isLoading) {
        return <div className="text-sm text-muted-foreground">Loading Adloggs details…</div>;
    }
    if (!fulfillments.length) {
        return <div className="text-sm text-muted-foreground">No Adloggs delivery for this order yet.</div>;
    }

    const wallet = (walletQuery.data as any)?.adloggsWalletBalance;

    return (
        <div className="space-y-2">
            {fulfillments.map(f => {
                const label = f.statusId != null ? (STATUS_LABELS[f.statusId] ?? `Status ${f.statusId}`) : 'Not created';
                const problem = f.statusId != null && PROBLEM_STATUSES.includes(f.statusId);
                return (
                    <div key={f.id} className="overflow-hidden rounded-md border">
                        <div className="flex items-center justify-between bg-muted/40 px-3 py-2">
                            <div className="flex min-w-0 items-center gap-2">
                                <span className="text-sm font-semibold">Adloggs Delivery</span>
                                <span
                                    className={
                                        problem || f.error
                                            ? 'rounded bg-destructive/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-destructive'
                                            : 'rounded bg-primary/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-primary'
                                    }
                                >
                                    {f.error && !f.uuid ? 'Failed' : label}
                                </span>
                            </div>
                            <Button
                                type="button"
                                variant="secondary"
                                disabled={sync.isPending}
                                onClick={() => sync.mutate(f.id)}
                            >
                                {sync.isPending ? 'Syncing…' : f.uuid ? 'Sync' : 'Retry'}
                            </Button>
                        </div>
                        <div className="border-t p-3">
                            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
                                <Info label="Fulfillment" value={`#${f.id} · ${f.state}`} />
                                <Info label="Adloggs Status" value={label} accent />
                                <Info label="Delivery Fee" value={f.fee ? `₹${f.fee}` : null} />
                                <Info label="Rider" value={f.riderName} />
                                <Info label="Rider Phone" value={f.riderPhone} />
                                <Info label="Order UUID" value={f.uuid} />
                            </dl>
                            {f.trackUrl ? (
                                <div className="mt-3 border-t pt-3">
                                    <a
                                        className="text-xs text-primary underline"
                                        href={f.trackUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        Live tracking map
                                    </a>
                                </div>
                            ) : null}
                            {f.error ? (
                                <div className="mt-3 border-t pt-3 text-xs text-destructive">{f.error}</div>
                            ) : null}
                            {problem ? (
                                <div className="mt-3 border-t pt-3 text-xs text-destructive">
                                    {f.statusId === 6
                                        ? 'The Adloggs delivery was cancelled.'
                                        : 'The goods are being returned to the store — resolve this order manually.'}
                                </div>
                            ) : null}
                        </div>
                    </div>
                );
            })}
            {wallet?.enabled && wallet?.balance != null ? (
                <div className="text-xs text-muted-foreground">Adloggs wallet balance: ₹{wallet.balance}</div>
            ) : null}
        </div>
    );
}

function Info({ label, value, accent }: { label: string; value: string | null | undefined; accent?: boolean }) {
    return (
        <div>
            <dt className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
            <dd className={accent ? 'break-all font-medium text-primary' : 'break-all font-medium'}>
                {value || 'N/A'}
            </dd>
        </div>
    );
}

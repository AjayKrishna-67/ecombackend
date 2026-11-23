import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Button, toast } from '@vendure/dashboard';
import React, { useState } from 'react';

import {
    shiprocketOrderFulfillmentsDocument,
    shiprocketTrackingDocument,
    syncShiprocketFulfillmentDocument,
} from './order-shiprocket-queries';

interface FulfillmentInfo {
    fulfillmentId: string;
    state: string | null;
    shiprocketOrderId: string | null;
    channelOrderId: string | null;
    shipmentId: string | null;
    status: string | null;
    awb: string | null;
    courierName: string | null;
    courierId: string | null;
    trackUrl: string | null;
    length: number | null;
    breadth: number | null;
    height: number | null;
    weightGrams: number | null;
    lastSyncedAt: string | null;
}

/**
 * "Shiprocket International" card on the order-detail page: collapsible
 * per-shipment boxes (matching the Quick card style) with stored shipment data,
 * Sync-from-Shiprocket and the live tracking timeline.
 */
export function ShiprocketOrderBlock({ context }: { context: any }) {
    const orderId = context?.entity?.id as string | undefined;
    const queryClient = useQueryClient();
    const queryKey = ['shiprocket-fulfillments', orderId];

    const infoQuery = useQuery({
        queryKey,
        queryFn: () => api.query(shiprocketOrderFulfillmentsDocument, { orderId: orderId! }),
        enabled: !!orderId,
    });

    const sync = useMutation({
        mutationFn: (fulfillmentId: string) =>
            api.mutate(syncShiprocketFulfillmentDocument, { fulfillmentId }),
        onSuccess: (res: any) => {
            const r = res?.syncShiprocketFulfillment;
            if (r?.success) {
                toast.success(`Synced: ${r.status ?? 'updated'}${r.awb ? ` · AWB ${r.awb}` : ''}`);
            } else {
                toast.error(r?.message ?? 'Sync failed');
            }
            queryClient.invalidateQueries({ queryKey });
        },
        onError: (e: any) => toast.error(e?.message ?? 'Sync failed'),
    });

    const list: FulfillmentInfo[] = (infoQuery.data as any)?.shiprocketOrderFulfillments ?? [];

    if (infoQuery.isLoading) {
        return <div className="text-sm text-muted-foreground">Loading Shiprocket shipment…</div>;
    }
    if (!list.length) {
        return <div className="text-sm text-muted-foreground">No Shiprocket shipment for this order yet.</div>;
    }

    return (
        <div className="space-y-2">
            {list.map(f => (
                <IntlShipmentCard
                    key={f.fulfillmentId}
                    f={f}
                    syncing={sync.isPending}
                    onSync={() => sync.mutate(f.fulfillmentId)}
                />
            ))}
        </div>
    );
}

function IntlShipmentCard({
    f,
    syncing,
    onSync,
}: {
    f: FulfillmentInfo;
    syncing: boolean;
    onSync: () => void;
}) {
    const cancelled = f.state === 'Cancelled';
    const [expanded, setExpanded] = useState(!cancelled);
    return (
        <div className="overflow-hidden rounded-md border">
            {/* Header — click to toggle */}
            <div
                className="flex cursor-pointer select-none items-center justify-between bg-muted/40 px-3 py-2 hover:bg-muted/70"
                onClick={() => setExpanded(e => !e)}
            >
                <div className="flex min-w-0 items-center gap-2">
                    <span className="text-[0.6rem] text-muted-foreground">{expanded ? '▼' : '▶'}</span>
                    <span className="truncate text-sm font-semibold">Shiprocket International</span>
                    {f.status && !cancelled ? (
                        <span className="rounded bg-primary/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-primary">
                            {f.status}
                        </span>
                    ) : null}
                    {cancelled ? (
                        <span className="rounded bg-destructive/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-destructive">
                            Cancelled
                        </span>
                    ) : null}
                    {f.shiprocketOrderId ? (
                        <span className="text-xs text-muted-foreground">#{f.shiprocketOrderId}</span>
                    ) : null}
                </div>
                <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    disabled={syncing}
                    onClick={e => {
                        e.stopPropagation();
                        onSync();
                    }}
                >
                    {syncing ? 'Syncing…' : 'Sync'}
                </Button>
            </div>

            {expanded ? (
                <div className="border-t p-3">
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
                        <Info label="Order ID (sent to Shiprocket)" value={f.channelOrderId} />
                        <Info label="Shiprocket Order" value={f.shiprocketOrderId} />
                        <Info label="Shipment ID" value={f.shipmentId} />
                        <Info label="AWB Code" value={f.awb} />
                        <Info label="Courier" value={f.courierName} />
                        <Info
                            label="Box (L×B×H cm)"
                            value={f.length != null ? `${f.length}×${f.breadth}×${f.height}` : null}
                        />
                        <Info label="Weight" value={f.weightGrams != null ? `${f.weightGrams} g` : null} />
                        <Info
                            label="Last Synced"
                            value={f.lastSyncedAt ? new Date(f.lastSyncedAt).toLocaleString() : null}
                        />
                    </dl>

                    <div className="mt-3 border-t pt-3">
                        {f.awb ? (
                            <TrackingSection awb={f.awb} />
                        ) : (
                            <p className="text-xs text-muted-foreground">
                                AWB not generated yet — assign a courier in Shiprocket, then Sync.
                            </p>
                        )}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function Info({ label, value }: { label: string; value: string | null | undefined }) {
    return (
        <div>
            <dt className="text-[0.65rem] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
            <dd className="break-all font-medium">{value || 'N/A'}</dd>
        </div>
    );
}

function TrackingSection({ awb }: { awb: string }) {
    const [show, setShow] = useState(false);
    const trackQuery = useQuery({
        queryKey: ['shiprocket-tracking', awb],
        queryFn: () => api.query(shiprocketTrackingDocument, { awb }),
        enabled: show,
    });
    const tracking = (trackQuery.data as any)?.shiprocketTracking;
    const activities: any[] = tracking?.activities ?? [];

    return (
        <div>
            <div className="flex items-center gap-3">
                <Button variant="ghost" type="button" onClick={() => setShow(s => !s)}>
                    {show ? 'Hide tracking' : 'View tracking'}
                </Button>
                {tracking?.trackUrl ? (
                    <a className="text-xs text-primary underline" href={tracking.trackUrl} target="_blank" rel="noreferrer">
                        Open on Shiprocket
                    </a>
                ) : null}
            </div>
            {show && trackQuery.isLoading && (
                <div className="mt-2 text-xs text-muted-foreground">Loading tracking…</div>
            )}
            {show && !trackQuery.isLoading && !activities.length && (
                <div className="mt-2 text-xs text-muted-foreground">No tracking activity yet.</div>
            )}
            {show && activities.length > 0 && (
                <ol className="mt-3 space-y-2">
                    {activities.map((a, i) => (
                        <li key={i} className="flex gap-3 text-sm">
                            <span className="w-36 shrink-0 text-xs text-muted-foreground">{a.date}</span>
                            <span>
                                <span className="font-medium">{a.srStatusLabel || a.activity}</span>
                                {a.location ? <span className="text-muted-foreground"> · {a.location}</span> : null}
                            </span>
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}

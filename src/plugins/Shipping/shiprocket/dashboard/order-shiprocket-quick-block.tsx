import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Button, toast } from '@vendure/dashboard';
import React, { useState } from 'react';

import {
    assignShiprocketAwbDocument,
    shiprocketQuickDetailsDocument,
    shiprocketQuickTrackingDocument,
} from './quick-queries';

interface QuickOrder {
    id: number;
    channel_order_id: string;
    status: string;
    pickup_location: string;
    payment_method: string;
    shipmentId: number | null;
    awb: string | null;
    courier: string | null;
    shipmentStatus: string | null;
    etd: string | null;
}

/**
 * "Shiprocket Quick" card on the order-detail page: collapsible per-order boxes
 * (like the Angular admin card) with live Shiprocket data, Refresh and Ship Now.
 */
export function ShiprocketQuickOrderBlock({ context }: { context: any }) {
    const orderId = context?.entity?.id as string | undefined;
    const queryClient = useQueryClient();
    const queryKey = ['shiprocket-quick-details', orderId];

    const detailsQuery = useQuery({
        queryKey,
        queryFn: () => api.query(shiprocketQuickDetailsDocument, { vendureOrderId: orderId! }),
        enabled: !!orderId,
    });

    const shipNow = useMutation({
        mutationFn: (shipmentId: number) => api.mutate(assignShiprocketAwbDocument, { shipmentId }),
        onSuccess: (res: any) => {
            const r = res?.assignShiprocketAwb;
            if (r?.success) {
                toast.success(r.message || 'Rider assignment in progress');
            } else {
                toast.error(r?.message || 'AWB assignment failed');
            }
            queryClient.invalidateQueries({ queryKey });
        },
        onError: (e: any) => toast.error(e?.message ?? 'AWB assignment failed'),
    });

    const raw: any[] = (detailsQuery.data as any)?.getShiprocketDetailsByVendureOrder ?? [];
    const orders: QuickOrder[] = raw.map(o => ({
        id: o.id,
        channel_order_id: o.channel_order_id,
        status: o.status,
        pickup_location: o.pickup_location,
        payment_method: o.payment_method,
        shipmentId: o.shipments?.id ?? null,
        awb: o.shipments?.awb || null,
        courier: o.shipments?.courier || null,
        shipmentStatus: o.shipments?.status || null,
        etd: o.shipments?.etd || null,
    }));

    if (detailsQuery.isLoading) {
        return <div className="text-sm text-muted-foreground">Loading Shiprocket Quick details…</div>;
    }
    if (!orders.length) {
        return <div className="text-sm text-muted-foreground">No Shiprocket Quick order for this order yet.</div>;
    }

    return (
        <div className="space-y-2">
            {orders.map(o => (
                <QuickOrderCard
                    key={o.id}
                    order={o}
                    refreshing={detailsQuery.isFetching}
                    onRefresh={() => queryClient.invalidateQueries({ queryKey })}
                    shipping={shipNow.isPending}
                    onShipNow={() => o.shipmentId && shipNow.mutate(o.shipmentId)}
                />
            ))}
        </div>
    );
}

function QuickOrderCard({
    order: o,
    refreshing,
    onRefresh,
    shipping,
    onShipNow,
}: {
    order: QuickOrder;
    refreshing: boolean;
    onRefresh: () => void;
    shipping: boolean;
    onShipNow: () => void;
}) {
    const cancelled = o.status === 'CANCELED';
    const [expanded, setExpanded] = useState(!cancelled);
    return (
        <div className="overflow-hidden rounded-md border">
            {/* Header — click to toggle, like the Angular card */}
            <div
                className="flex cursor-pointer select-none items-center justify-between bg-muted/40 px-3 py-2 hover:bg-muted/70"
                onClick={() => setExpanded(e => !e)}
            >
                <div className="flex min-w-0 items-center gap-2">
                    <span className="text-[0.6rem] text-muted-foreground">{expanded ? '▼' : '▶'}</span>
                    <span className="text-sm font-semibold">Shiprocket Quick</span>
                    <span
                        className={
                            cancelled
                                ? 'rounded bg-destructive/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-destructive'
                                : 'rounded bg-primary/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-primary'
                        }
                    >
                        {o.status || 'N/A'}
                    </span>
                    <span className="text-xs text-muted-foreground">#{o.id}</span>
                </div>
                <button
                    type="button"
                    title="Reload"
                    disabled={refreshing}
                    className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={e => {
                        e.stopPropagation();
                        onRefresh();
                    }}
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={refreshing ? 'animate-spin' : undefined}
                    >
                        <polyline points="23 4 23 10 17 10"></polyline>
                        <polyline points="1 20 1 14 7 14"></polyline>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                    </svg>
                </button>
            </div>

            {expanded ? (
                <div className="border-t p-3">
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
                        <Info label="Order ID" value={String(o.id)} />
                        <Info label="Channel Order ID" value={o.channel_order_id} />
                        <Info label="Shipment ID" value={o.shipmentId != null ? String(o.shipmentId) : null} />
                        <Info label="Status" value={o.status} accent />
                        <Info label="AWB Code" value={o.awb} />
                        <Info label="Courier" value={o.courier} />
                        <Info label="Pickup Location" value={o.pickup_location} />
                        <Info label="ETD" value={o.etd} />
                        <Info label="Payment" value={o.payment_method} />
                        <Info label="Shipment Status" value={o.shipmentStatus} accent />
                    </dl>
                    {!o.awb && o.shipmentId && !cancelled ? (
                        <div className="mt-3 border-t pt-3">
                            <Button type="button" disabled={shipping} onClick={onShipNow}>
                                {shipping ? 'Assigning…' : 'Ship Now'}
                            </Button>
                        </div>
                    ) : null}
                    {o.shipmentId && !cancelled ? (
                        <div className="mt-3 border-t pt-3">
                            <QuickTrackingSection shipmentId={o.shipmentId} />
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function QuickTrackingSection({ shipmentId }: { shipmentId: number }) {
    const [show, setShow] = useState(false);
    const trackQuery = useQuery({
        queryKey: ['shiprocket-quick-tracking', shipmentId],
        queryFn: () => api.query(shiprocketQuickTrackingDocument, { shipmentId }),
        enabled: show,
    });
    const tracking = (trackQuery.data as any)?.getShiprocketQuickTracking;
    const activities: any[] = tracking?.activities ?? [];

    return (
        <div>
            <div className="flex flex-wrap items-center gap-3">
                <Button variant="ghost" type="button" onClick={() => setShow(s => !s)}>
                    {show ? 'Hide tracking' : 'View tracking'}
                </Button>
                {tracking?.currentStatus ? (
                    <span className="rounded bg-primary/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-primary">
                        {tracking.currentStatus}
                    </span>
                ) : null}
                {tracking?.awb ? (
                    <span className="text-xs text-muted-foreground">AWB {tracking.awb}</span>
                ) : null}
                {tracking?.trackUrl ? (
                    <a
                        className="text-xs text-primary underline"
                        href={tracking.trackUrl}
                        target="_blank"
                        rel="noreferrer"
                    >
                        Open on Shiprocket
                    </a>
                ) : null}
            </div>
            {show && trackQuery.isLoading && (
                <div className="mt-2 text-xs text-muted-foreground">Loading tracking…</div>
            )}
            {show && !trackQuery.isLoading && !tracking && (
                <div className="mt-2 text-xs text-muted-foreground">No tracking data yet.</div>
            )}
            {show && tracking?.error && (
                <div className="mt-2 text-xs text-destructive">{tracking.error}</div>
            )}
            {show && tracking && !tracking.error && !activities.length && (
                <div className="mt-2 text-xs text-muted-foreground">
                    No tracking activity yet — the rider has not been assigned.
                </div>
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

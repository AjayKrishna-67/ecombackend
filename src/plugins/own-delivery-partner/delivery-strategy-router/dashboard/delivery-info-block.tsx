import { api, Badge, Card, CardContent, PageContextValue, Spinner, useLocalFormat } from '@vendure/dashboard';
import { useQuery } from '@tanstack/react-query';
import { Package } from 'lucide-react';
import React from 'react';
import { DeliveryAssignment, getOrderDeliveryAssignmentsDocument } from './queries';

const STATE_MAP: Record<string, { label: string; variant: string }> = {
    Shipped: { label: 'ASSIGNED', variant: 'secondary' },
    Cancelled: { label: 'CANCELLED', variant: 'destructive' },
    OutforDelivery: { label: 'OUT FOR DELIVERY', variant: 'warning' },
    Delivered: { label: 'DELIVERED', variant: 'success' },
    Pending: { label: 'PENDING', variant: 'outline' },
};

function getStateStyle(state: string): { label: string; variant: string } {
    return STATE_MAP[state] ?? { label: state.toUpperCase(), variant: 'secondary' };
}

export function DeliveryInfoBlock({ context }: { context: PageContextValue }) {
    const { formatDate } = useLocalFormat();
    const orderId = context.entity?.id ? String(context.entity.id) : undefined;
    const { data, isLoading } = useQuery({
        queryKey: ['order-delivery-assignments', orderId],
        queryFn: () => api.query(getOrderDeliveryAssignmentsDocument, { orderId: orderId! }),
        enabled: !!orderId,
    });
    const assignments: DeliveryAssignment[] = (data as any)?.orderDeliveryAssignments ?? [];

    if (isLoading) {
        return (
            <div className="flex justify-center p-4">
                <Spinner />
            </div>
        );
    }
    if (assignments.length === 0) {
        return <div className="text-muted-foreground p-2 text-sm">No delivery assignments.</div>;
    }

    return (
        <div className="space-y-3">
            {assignments.map(a => {
                const s = getStateStyle(a.state);
                return (
                    <Card key={a.fulfillmentId} className="overflow-hidden">
                        <CardContent className="p-0">
                            <div className="bg-muted/40 flex items-center justify-between border-b px-3 py-2">
                                <span className="flex items-center gap-1.5 text-sm font-semibold">
                                    <Package className="h-4 w-4" />
                                    Fulfillment #{a.fulfillmentId}
                                </span>
                                <Badge variant={s.variant as any}>{s.label}</Badge>
                            </div>
                            <div className="space-y-1 px-3 py-2 text-sm">
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Delivery Person</span>
                                    <span className="font-medium">{a.deliveryPersonName}</span>
                                </div>
                                {a.deliveryPersonPhone && (
                                    <div className="flex justify-between">
                                        <span className="text-muted-foreground">Phone</span>
                                        <span className="font-medium">{a.deliveryPersonPhone}</span>
                                    </div>
                                )}
                                <div className="flex justify-between">
                                    <span className="text-muted-foreground">Assigned</span>
                                    <span className="font-medium">{formatDate(a.createdAt)}</span>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                );
            })}
        </div>
    );
}

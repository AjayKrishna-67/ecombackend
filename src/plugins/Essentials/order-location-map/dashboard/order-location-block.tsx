import { useQuery } from '@tanstack/react-query';
import { api, graphql } from '@vendure/dashboard';
import { ExternalLink, Store } from 'lucide-react';
import React from 'react';

export const orderShippingLocationDocument = graphql(`
    query OrderShippingLocation($id: ID!) {
        order(id: $id) {
            id
            customFields {
                isTakeAway
                pickupAddress
                pickupLatitude
                pickupLongitude
                pickupSlot {
                    from
                    to
                }
                pickupTime
            }
            shippingLines {
                shippingMethod {
                    name
                }
            }
            shippingAddress {
                customFields {
                    latitude
                    longitude
                }
            }
        }
    }
`);

function MapCard({
    lat,
    lng,
    title,
    header,
}: Readonly<{ lat: number; lng: number; title: string; header?: React.ReactNode }>) {
    return (
        <div className="space-y-2">
            {header}
            <iframe
                title={title}
                src={`https://maps.google.com/maps?q=${lat},${lng}&z=16&output=embed`}
                className="w-full rounded-md border-0"
                height={280}
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
            />
            <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                    {lat}, {lng}
                </span>
                <a
                    href={`https://www.google.com/maps?q=${lat},${lng}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-primary hover:underline"
                >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open in Google Maps
                </a>
            </div>
        </div>
    );
}

export function OrderLocationBlock({ context }: Readonly<{ context: any }>) {
    const orderId = context?.entity?.id as string | undefined;

    const { data, isLoading } = useQuery({
        queryKey: ['order-shipping-location', orderId],
        queryFn: () => api.query(orderShippingLocationDocument, { id: orderId! }),
        enabled: !!orderId,
    });

    if (isLoading) {
        return <div className="text-sm text-muted-foreground">Loading location…</div>;
    }

    const order = (data as any)?.order;

    // Take Away order: show the pickup store (snapshotted from the shipping
    // method at order placement) instead of the customer's delivery pin.
    const oc = order?.customFields;
    if (oc?.isTakeAway && oc.pickupLatitude != null && oc.pickupLongitude != null) {
        return (
            <MapCard
                lat={oc.pickupLatitude}
                lng={oc.pickupLongitude}
                title="Pickup store map"
                header={
                    <div className="flex items-center gap-1.5 text-sm text-foreground">
                        <Store className="h-4 w-4 shrink-0" />
                        <span>Take Away{oc.pickupAddress ? ` — ${oc.pickupAddress}` : ''}</span>
                    </div>
                }
            />
        );
    }

    const customFields = order?.shippingAddress?.customFields;
    const lat = customFields?.latitude;
    const lng = customFields?.longitude;

    if (lat == null || lng == null) {
        return <div className="text-sm text-muted-foreground">No location pinned by the customer</div>;
    }

    return <MapCard lat={lat} lng={lng} title="Delivery location map" />;
}

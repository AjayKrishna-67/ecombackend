import {
    api,
    DashboardFormComponent,
    graphql,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@vendure/dashboard';
import { useQuery } from '@tanstack/react-query';
import React, { useEffect, useMemo, useState } from 'react';
import { DeliveryPerson, getDeliveryPersonsDocument } from './queries';

const getOrderPickupInfoDocument = graphql(`
    query GetOrderPickupInfo($id: ID!) {
        order(id: $id) {
            id
            shippingLines {
                shippingMethod {
                    id
                    customFields {
                        storeLatitude
                    }
                }
            }
        }
    }
`);

const METHODS = [
    { value: 'own-delivery-fleet', label: 'Own Delivery Fleet' },
    { value: 'shiprocket-quick', label: 'Shiprocket Quick' },
    { value: 'adloggs', label: 'Adloggs' },
    { value: 'manual', label: 'Take Away (Manual)' },
];

export const KaaikaniFulfillmentInput: DashboardFormComponent = ({ value, onChange }) => {
    const parsed = useMemo(() => {
        try {
            return typeof value === 'string' ? JSON.parse(value) : value || {};
        } catch {
            return {};
        }
    }, [value]);

    const [type, setType] = useState<string>(parsed.type ?? '');
    const [personId, setPersonId] = useState<string>(parsed.deliveryPersonId ?? '');

    const { data } = useQuery({
        queryKey: ['delivery-persons'],
        queryFn: () => api.query(getDeliveryPersonsDocument),
    });
    const persons: DeliveryPerson[] = (data as any)?.deliveryPersons ?? [];

    const emit = (nextType: string, nextPerson: string) =>
        onChange?.(JSON.stringify({ type: nextType, deliveryPersonId: nextPerson }));

    // The fulfillment dialog opens on the order-detail route. If that order's
    // shipping method is a Take Away pickup method (store pinned — see the
    // take-away plugin), default the picker to "Take Away (Manual)". Staff
    // can still change it; an already-chosen value is never overridden.
    const orderId = window.location.pathname.match(/\/orders\/(\d+)/)?.[1];
    const { data: pickupData } = useQuery({
        queryKey: ['order-pickup-info', orderId],
        queryFn: () => api.query(getOrderPickupInfoDocument, { id: orderId! }),
        enabled: !!orderId && !type,
    });
    useEffect(() => {
        if (type) {
            return;
        }
        const isPickup = ((pickupData as any)?.order?.shippingLines ?? []).some(
            (line: any) => line.shippingMethod?.customFields?.storeLatitude != null,
        );
        if (isPickup) {
            setType('manual');
            setPersonId('');
            emit('manual', '');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pickupData]);

    return (
        <div className="flex w-full flex-col gap-4">
            <div className="flex flex-col gap-1.5">
                <Label>Delivery Method</Label>
                <Select
                    value={type}
                    onValueChange={v => {
                        const nextPerson = v === 'own-delivery-fleet' ? personId : '';
                        setType(v);
                        setPersonId(nextPerson);
                        emit(v, nextPerson);
                    }}
                >
                    <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select a delivery method" />
                    </SelectTrigger>
                    <SelectContent>
                        {METHODS.map(m => (
                            <SelectItem key={m.value} value={m.value}>
                                {m.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            {type === 'own-delivery-fleet' && (
                <div className="flex flex-col gap-1.5">
                    <Label>Delivery Person</Label>
                    <Select
                        value={personId}
                        onValueChange={v => {
                            setPersonId(v);
                            emit(type, v);
                        }}
                    >
                        <SelectTrigger className="w-full">
                            <SelectValue placeholder="Assign a delivery person" />
                        </SelectTrigger>
                        <SelectContent>
                            {persons.map(p => (
                                <SelectItem key={p.id} value={String(p.id)}>
                                    {p.firstName} {p.lastName}
                                    {p.phoneNumber ? ` · ${p.phoneNumber}` : ''}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            )}
        </div>
    );
};

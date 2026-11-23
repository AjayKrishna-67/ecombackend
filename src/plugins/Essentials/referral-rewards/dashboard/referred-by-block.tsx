import { api, Badge, PageContextValue, Spinner } from '@vendure/dashboard';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Users } from 'lucide-react';
import React from 'react';
import { getCustomerReferredByDocument, ReferredBy } from './queries';

export function ReferredByBlock({ context }: { context: PageContextValue }) {
    const customerId = context.entity?.id ? String(context.entity.id) : undefined;
    const { data, isLoading } = useQuery({
        queryKey: ['customer-referred-by', customerId],
        queryFn: () => api.query(getCustomerReferredByDocument, { customerId: customerId! }),
        enabled: !!customerId,
    });
    const referredBy = (data as any)?.customer?.referredBy as ReferredBy | null | undefined;

    if (isLoading) {
        return (
            <div className="flex justify-center p-4">
                <Spinner />
            </div>
        );
    }
    if (!referredBy) {
        return <div className="text-muted-foreground p-2 text-sm">Not referred by anyone.</div>;
    }

    return (
        <div className="space-y-1.5 p-1 text-sm">
            <div className="text-muted-foreground flex items-center gap-1 text-xs">
                <Users className="h-3.5 w-3.5" />
                Referred by
            </div>
            <Link
                to="/customers/$id"
                params={{ id: referredBy.referrer.id }}
                className="text-primary font-medium hover:underline"
            >
                {referredBy.referrer.firstName} {referredBy.referrer.lastName}
            </Link>
            <div className="flex items-center gap-2">
                <Badge variant="secondary">{referredBy.status}</Badge>
                {referredBy.points > 0 && (
                    <span className="text-success font-medium">{referredBy.points} pts</span>
                )}
            </div>
        </div>
    );
}

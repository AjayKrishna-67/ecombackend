import { useQuery } from '@tanstack/react-query';
import { api, HistoryTimeline, PageContextValue, Spinner } from '@vendure/dashboard';
import React from 'react';
import { ActivityTimelineEntry } from './activity-entry';
import { AdminActivityLogRow, getAdminActivityForEntityDocument } from './queries';

const MAX_ENTRIES = 100;

/**
 * Refetch cadence for the history block. Must stay comfortably above the
 * writer's 2s flush interval so a save has landed by the time the next poll
 * runs, and low enough that the entry appears while the operator is still
 * looking at the page. Costs one indexed query per interval, and only while a
 * detail page is actually open.
 */
const POLL_INTERVAL_MS = 10_000;

/**
 * Renders the audit trail for one entity using the Dashboard's own
 * `HistoryTimeline` components rather than a bespoke list, so this reads
 * identically to the Order and Customer history that operators already know.
 */
export function EntityHistoryBlock(props: { context: PageContextValue; entityType: string }) {
    const entityId = props.context.entity?.id;

    const { data, isLoading } = useQuery({
        queryKey: ['admin-activity-for-entity', props.entityType, entityId],
        // `enabled` guards the create page, where there is no entity yet and the
        // query would fire with an undefined id on every keystroke.
        enabled: entityId != null,
        // Saving the form does not make the new row appear: the writer buffers
        // audit rows for FLUSH_INTERVAL_MS before the bulk INSERT, so at the
        // moment the mutation returns the row does not exist yet. Invalidating
        // the cache on save would therefore refetch too early and still show
        // nothing. Polling on an interval comfortably longer than the flush is
        // what actually makes the entry turn up without a manual reload.
        refetchInterval: POLL_INTERVAL_MS,
        refetchOnWindowFocus: true,
        staleTime: 0,
        queryFn: () =>
            api.query(getAdminActivityForEntityDocument, {
                entityType: props.entityType,
                entityId: String(entityId),
                take: MAX_ENTRIES,
            }),
    });

    if (entityId == null) {
        return null;
    }
    if (isLoading) {
        return (
            <div className="flex justify-center py-6">
                <Spinner />
            </div>
        );
    }

    const rows: AdminActivityLogRow[] = (data as any)?.adminActivityForEntity ?? [];
    if (rows.length === 0) {
        return (
            <div className="text-muted-foreground py-6 text-sm">
                No recorded admin activity for this {props.entityType.toLowerCase()}. The audit log only
                covers actions taken since it was deployed.
            </div>
        );
    }

    return (
        <HistoryTimeline>
            {rows.map(row => (
                <ActivityTimelineEntry key={row.id} row={row} />
            ))}
        </HistoryTimeline>
    );
}

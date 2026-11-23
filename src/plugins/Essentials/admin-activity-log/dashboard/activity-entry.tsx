import { Link } from '@tanstack/react-router';
import { Button, HistoryEntry } from '@vendure/dashboard';
import { ArrowRight, Ban, CheckCircle2, Code2, PencilLine, Plus, Trash2, TriangleAlert } from 'lucide-react';
import React, { useState } from 'react';
import {
    ChangeSummary,
    describeAction,
    describeChanges,
    formatDuration,
    isDestructive,
    MAX_LISTED_FIELDS,
    parseUserAgent,
} from './format';
import { AdminActivityLogRow } from './queries';

/**
 * One audit row rendered as a Vendure timeline entry.
 *
 * Shared by the Admin Activity list and the per-entity history block so both
 * read identically to the Order and Customer history operators already know.
 * Matching an existing pattern beats inventing a second one — and having one
 * implementation means a fix to the icon rules or the payload toggle lands in
 * both places at once.
 */
export function ActivityTimelineEntry(props: { row: AdminActivityLogRow; showSessionLink?: boolean }) {
    const { row, showSessionLink } = props;
    return (
        <HistoryEntry
            entry={toHistoryEntryItem(row)}
            title={<ActivityTitle row={row} />}
            actorName={row.adminName}
            timelineIcon={<TimelineIcon row={row} />}
            timelineIconClassName={iconClassName(row)}
            isPrimary={isDestructive(row) || row.outcome === 'ERROR'}
        >
            <EntryDetail row={row} showSessionLink={showSessionLink} />
        </HistoryEntry>
    );
}

/**
 * The entry's headline, made clickable when the row's target has a page.
 *
 * `entityLink` is null unless the server matched the row's entity type against
 * its allowlist, so an unrecognised or nonsensical type renders as plain text
 * instead of a link that 404s. The table still holds rows filed under
 * `tlePayment` and `FulfillmentToOrder` from before the operation-name parser was
 * fixed; those must never become clickable.
 */
export function ActivityTitle(props: { row: AdminActivityLogRow }) {
    const { row } = props;
    const label = describeAction(row);
    if (!row.entityLink) {
        return <>{label}</>;
    }
    return (
        // The path is assembled server-side from a fixed allowlist of routes,
        // which is the guarantee here — the router's own union type cannot see
        // that, since the string is only known at runtime.
        <Link
            to={row.entityLink as never}
            className="hover:text-primary underline-offset-2 hover:underline"
        >
            {label}
        </Link>
    );
}

/**
 * Adapts an audit row to the shape the Dashboard timeline expects. `adminName`
 * is a single stored string — a snapshot taken at write time so the log survives
 * the administrator being deleted — so it is split back into the first/last
 * pair the component wants, rather than re-joining to a possibly-gone record.
 */
export function toHistoryEntryItem(row: AdminActivityLogRow) {
    const [firstName, ...rest] = row.adminName.split(' ');
    return {
        id: row.id,
        type: row.operationName,
        createdAt: row.createdAt,
        isPublic: false,
        administrator: row.adminId
            ? { id: String(row.adminId), firstName, lastName: rest.join(' ') }
            : null,
        data: row.payload ?? {},
    };
}

function TimelineIcon(props: { row: AdminActivityLogRow }) {
    const { row } = props;
    if (row.outcome === 'ERROR') {
        return <TriangleAlert className="h-4 w-4" />;
    }
    if (/^delete/i.test(row.operationName)) {
        return <Trash2 className="h-4 w-4" />;
    }
    const enabled = readEnabled(row);
    if (enabled === false) {
        return <Ban className="h-4 w-4" />;
    }
    if (enabled === true) {
        return <CheckCircle2 className="h-4 w-4" />;
    }
    if (/^(create|add)/i.test(row.operationName)) {
        return <Plus className="h-4 w-4" />;
    }
    return <PencilLine className="h-4 w-4" />;
}

function iconClassName(row: AdminActivityLogRow): string {
    if (row.outcome === 'ERROR') {
        return 'bg-destructive text-destructive-foreground';
    }
    if (isDestructive(row)) {
        return 'bg-amber-500 text-white';
    }
    return 'bg-muted text-muted-foreground';
}

/**
 * The payload is the raw mutation input and is frequently hundreds of lines of
 * translations and custom fields. Rendering it inline drowned the timeline, so it
 * sits behind a toggle: the summary line answers "what changed, from where", and
 * the payload is there when that is not enough.
 */
function EntryDetail(props: { row: AdminActivityLogRow; showSessionLink?: boolean }) {
    const { row, showSessionLink } = props;
    const [showPayload, setShowPayload] = useState(false);
    const device = parseUserAgent(row.userAgent);
    const changes = describeChanges(row);

    return (
        <div className="space-y-2 text-xs">
            {changes && <ChangeList changes={changes} />}
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono">{row.operationName}</span>
                <span>{formatDuration(row.durationMs)}</span>
                {device && (
                    // The raw UA and the IP both hang off the title, so the
                    // forensic detail stays reachable without spending a column
                    // on it in every row.
                    <span title={`${row.userAgent ?? ''}\n${row.ipAddress ?? ''}`.trim()}>
                        {device.browser} · {device.os} · {device.deviceType}
                    </span>
                )}
                {!device && row.ipAddress && <span className="font-mono">{row.ipAddress}</span>}
                {row.targetCount > 1 && <span>{row.targetCount} items in this call</span>}
                {showSessionLink && row.sessionId && (
                    <Link
                        to="/admin-activity/sessions/$sessionId"
                        params={{ sessionId: row.sessionId }}
                        className="hover:text-primary underline underline-offset-2"
                    >
                        session
                    </Link>
                )}
                {row.payload && (
                    <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs"
                        onClick={() => setShowPayload(value => !value)}
                    >
                        <Code2 className="mr-1 h-3 w-3" />
                        {showPayload ? 'Hide payload' : 'Payload'}
                    </Button>
                )}
            </div>
            {row.errorMessage && <div className="text-destructive">{row.errorMessage}</div>}
            {showPayload && row.payload && (
                <pre className="bg-muted max-h-56 overflow-auto rounded p-2">
                    {JSON.stringify(row.payload, null, 2)}
                </pre>
            )}
        </div>
    );
}

/**
 * Only reports `enabled` when the diff confirms it changed. Without that guard
 * the timeline drew a ban/check icon on every ordinary edit, because the
 * Dashboard resubmits `enabled` with the rest of the form whether or not anyone
 * touched it.
 */
function readEnabled(row: AdminActivityLogRow): boolean | undefined {
    if (row.changedFields?.includes('enabled') !== true) {
        return undefined;
    }
    const input = row.payload?.input as Record<string, unknown> | undefined;
    const value = input?.enabled;
    return typeof value === 'boolean' ? value : undefined;
}

/**
 * The before/after list, one line per field.
 *
 * An empty list is rendered as "no fields changed" rather than hidden, because
 * the diff having run and found nothing is a real finding — someone opened a
 * form and saved it without editing anything — and is very different from the
 * diff not having run at all, which shows nothing here.
 *
 * Values are omitted rather than faked when the server could not derive them:
 * the field name alone still says a change happened. Past MAX_LISTED_FIELDS the
 * remainder is counted, since the full detail is one click away in the payload.
 */
export function ChangeList(props: { changes: ChangeSummary[] }) {
    const { changes } = props;
    if (changes.length === 0) {
        return (
            <div>
                <span className="text-muted-foreground">Changed: </span>
                <span className="text-foreground font-medium">no fields changed</span>
            </div>
        );
    }
    const shown = changes.slice(0, MAX_LISTED_FIELDS);
    const remainder = changes.length - shown.length;
    return (
        <div className="space-y-1">
            {shown.map(change => (
                <div key={change.label} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-muted-foreground">{change.label}</span>
                    {change.from !== null && change.to !== null ? (
                        <span className="flex flex-wrap items-baseline gap-x-1.5">
                            <span className="text-muted-foreground line-through">{change.from}</span>
                            <ArrowRight className="text-muted-foreground h-3 w-3 shrink-0" />
                            <span className="text-foreground font-medium">{change.to}</span>
                        </span>
                    ) : (
                        <span className="text-foreground font-medium">changed</span>
                    )}
                </div>
            ))}
            {remainder > 0 && (
                <div className="text-muted-foreground">+{remainder} more</div>
            )}
        </div>
    );
}

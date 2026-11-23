import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
    api,
    Badge,
    Button,
    Card,
    CardContent,
    HistoryTimeline,
    Page,
    PageTitle,
    Spinner,
} from '@vendure/dashboard';
import { ActivityTimelineEntry, ActivityTitle, ChangeList } from './activity-entry';
import { AlertTriangle, ChevronLeft, ChevronRight, Monitor, Search, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { describeChanges, formatDuration, isDestructive, parseUserAgent } from './format';
import { AdminActivityLogRow, getAdminActivityLogsDocument } from './queries';

const PER_PAGE = 25;

type OutcomeFilter = 'ALL' | 'SUCCESS' | 'ERROR';
type ScopeFilter = 'ALL' | 'DESTRUCTIVE' | 'AUTH';

export function AdminActivityListPage() {
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState('');
    const [outcome, setOutcome] = useState<OutcomeFilter>('ALL');
    const [scope, setScope] = useState<ScopeFilter>('ALL');

    const options = useMemo(() => {
        const filter: Record<string, unknown> = {};
        if (search.trim()) {
            filter.adminName = { contains: search.trim() };
        }
        if (outcome !== 'ALL') {
            filter.outcome = { eq: outcome };
        }
        if (scope === 'AUTH') {
            filter.isAuthEvent = { eq: true };
        }
        return {
            skip: (page - 1) * PER_PAGE,
            take: PER_PAGE,
            sort: { createdAt: 'DESC' },
            filter,
        };
    }, [page, search, outcome, scope]);

    const { data, isLoading } = useQuery({
        queryKey: ['admin-activity-logs', options],
        queryFn: () => api.query(getAdminActivityLogsDocument, { options }),
    });

    const allItems: AdminActivityLogRow[] = (data as any)?.adminActivityLogs?.items ?? [];
    // Destructive is derived from the payload, which the server cannot filter on,
    // so this narrowing happens client-side over the current page only.
    const items = scope === 'DESTRUCTIVE' ? allItems.filter(isDestructive) : allItems;
    const total: number = (data as any)?.adminActivityLogs?.totalItems ?? 0;
    const hasFilters = !!search.trim() || outcome !== 'ALL' || scope !== 'ALL';

    const resetFilters = () => {
        setSearch('');
        setOutcome('ALL');
        setScope('ALL');
        setPage(1);
    };

    return (
        <Page pageId="admin-activity-list">
            <PageTitle>Admin Activity</PageTitle>
            <div className="space-y-4 px-4 pb-6">
                <Card>
                    <CardContent className="flex flex-wrap items-center gap-3 py-4">
                        <div className="relative min-w-[220px] flex-1">
                            <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
                            <input
                                value={search}
                                onChange={e => {
                                    setSearch(e.target.value);
                                    setPage(1);
                                }}
                                placeholder="Filter by administrator…"
                                className="bg-background w-full rounded border py-1.5 pl-8 pr-2 text-sm"
                            />
                        </div>
                        <FilterGroup
                            value={scope}
                            onChange={v => {
                                setScope(v);
                                setPage(1);
                            }}
                            options={[
                                ['ALL', 'All'],
                                ['DESTRUCTIVE', 'Destructive'],
                                ['AUTH', 'Sign-ins'],
                            ]}
                        />
                        <FilterGroup
                            value={outcome}
                            onChange={v => {
                                setOutcome(v);
                                setPage(1);
                            }}
                            options={[
                                ['ALL', 'Any'],
                                ['SUCCESS', 'Succeeded'],
                                ['ERROR', 'Failed'],
                            ]}
                        />
                        <Button size="sm" variant="outline" render={<Link to="/admin-activity/sessions" />}>
                            <Monitor className="mr-1 h-4 w-4" />
                            Sessions
                        </Button>
                        {hasFilters && (
                            <Button size="sm" variant="ghost" onClick={resetFilters}>
                                <X className="mr-1 h-4 w-4" />
                                Clear
                            </Button>
                        )}
                    </CardContent>
                </Card>

                {isLoading ? (
                    <div className="flex justify-center p-10">
                        <Spinner />
                    </div>
                ) : items.length === 0 ? (
                    <Card>
                        <CardContent className="text-muted-foreground py-16 text-center text-sm">
                            {hasFilters
                                ? 'No activity matches these filters.'
                                : 'No activity recorded yet. The log starts from the moment it was deployed — earlier actions were never captured.'}
                        </CardContent>
                    </Card>
                ) : (
                    <Card>
                        <CardContent className="py-6">
                            {/*
                              Rendered with the Dashboard's own timeline rather
                              than a flat list so this page reads exactly like
                              Order and Customer history: a rail, a filled icon
                              for the entries that matter, a plain dot for the
                              routine ones, actor and time on the right.
                            */}
                            <HistoryTimeline>
                                {items.map(row => (
                                    <ActivityTimelineEntry key={row.id} row={row} showSessionLink />
                                ))}
                            </HistoryTimeline>
                        </CardContent>
                    </Card>
                )}

                <div className="flex items-center justify-between">
                    <div className="text-muted-foreground text-sm">
                        {total} recorded action{total === 1 ? '' : 's'}
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={page === 1}
                            onClick={() => setPage(p => Math.max(1, p - 1))}
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <span className="text-sm font-semibold">{page}</span>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={page * PER_PAGE >= total}
                            onClick={() => setPage(p => p + 1)}
                        >
                            <ChevronRight className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            </div>
        </Page>
    );
}

function FilterGroup<T extends string>(props: {
    value: T;
    onChange: (value: T) => void;
    options: Array<[T, string]>;
}) {
    return (
        <div className="flex items-center gap-1">
            {props.options.map(([value, label]) => (
                <Button
                    key={value}
                    size="sm"
                    variant={props.value === value ? 'default' : 'outline'}
                    onClick={() => props.onChange(value)}
                >
                    {label}
                </Button>
            ))}
        </div>
    );
}

export function ActivityRow(props: { row: AdminActivityLogRow; hideAdmin?: boolean }) {
    const { row, hideAdmin } = props;
    const [expanded, setExpanded] = useState(false);
    const destructive = isDestructive(row);
    const failed = row.outcome === 'ERROR';
    const device = parseUserAgent(row.userAgent);
    const changes = describeChanges(row);

    return (
        <div className="py-3">
            <div className="flex items-start gap-3">
                <div
                    className={
                        'mt-1.5 h-2 w-2 shrink-0 rounded-full ' +
                        (failed ? 'bg-red-500' : destructive ? 'bg-amber-500' : 'bg-emerald-500')
                    }
                />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">
                            <ActivityTitle row={row} />
                        </span>
                        {destructive && !failed && (
                            <Badge variant="secondary" className="gap-1 text-xs">
                                <AlertTriangle className="h-3 w-3" />
                                destructive
                            </Badge>
                        )}
                        {failed && (
                            <Badge variant="destructive" className="text-xs">
                                failed
                            </Badge>
                        )}
                    </div>
                    {changes && (
                        // The field list sits on its own line directly under the
                        // action, because "what did they change" is the question
                        // that brings anyone to this page — burying it among the
                        // timestamp and duration made people open the payload.
                        //
                        // Rendered by the same component the timeline uses, so
                        // the two views can never disagree about how a value is
                        // formatted or where the list is truncated.
                        <div className="mt-0.5 text-xs">
                            <ChangeList changes={changes} />
                        </div>
                    )}
                    <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        {!hideAdmin && <span className="font-medium">{row.adminName}</span>}
                        <span>{new Date(row.createdAt).toLocaleString()}</span>
                        <span className="font-mono">{row.operationName}</span>
                        <span>{formatDuration(row.durationMs)}</span>
                        {device && (
                            // The raw UA and the IP both hang off the title, so the
                            // forensic detail stays reachable without spending a
                            // column on it in every row.
                            <span title={`${row.userAgent ?? ''}\n${row.ipAddress ?? ''}`.trim()}>
                                {device.browser} · {device.os} · {device.deviceType}
                            </span>
                        )}
                        {!device && row.ipAddress && (
                            <span className="font-mono">{row.ipAddress}</span>
                        )}
                        {row.sessionId && !hideAdmin && (
                            <Link
                                to="/admin-activity/sessions/$sessionId"
                                params={{ sessionId: row.sessionId }}
                                className="hover:text-primary underline underline-offset-2"
                            >
                                session
                            </Link>
                        )}
                        {row.payload && (
                            <button
                                type="button"
                                onClick={() => setExpanded(e => !e)}
                                className="hover:text-primary underline underline-offset-2"
                            >
                                {expanded ? 'hide payload' : 'payload'}
                            </button>
                        )}
                    </div>
                    {row.errorMessage && (
                        <div className="mt-1 text-xs text-red-500">{row.errorMessage}</div>
                    )}
                    {expanded && row.payload && (
                        <pre className="bg-muted mt-2 max-h-64 overflow-auto rounded p-2 text-xs">
                            {JSON.stringify(row.payload, null, 2)}
                        </pre>
                    )}
                </div>
            </div>
        </div>
    );
}

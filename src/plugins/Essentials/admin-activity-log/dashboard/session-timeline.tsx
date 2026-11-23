import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
    api,
    Badge,
    Button,
    Card,
    CardContent,
    Page,
    PageTitle,
    Spinner,
} from '@vendure/dashboard';
import {
    AlertTriangle,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Clock,
    Globe,
    Laptop,
    Search,
    Smartphone,
    Tablet,
    X,
} from 'lucide-react';
import React from 'react';
import { ActivityRow } from './activity-list';
import { DeviceInfo, formatGap, parseUserAgent } from './format';
import {
    AdminActivityLogRow,
    AdminActivitySessionRow,
    getAdminActivitySessionsDocument,
    getAdminActivitySessionTimelineDocument,
} from './queries';

/** Sessions fetched per window. Bounded by `since`, grouped in the browser. */
const SESSION_FETCH_LIMIT = 500;

const DATE_RANGES = [
    ['1', 'Today'],
    ['7', 'Last 7 days'],
    ['30', 'Last 30 days'],
    ['', 'All time'],
] as const;

const DEVICE_FILTERS = [
    ['ALL', 'All devices'],
    ['Desktop', 'Desktop'],
    ['Mobile', 'Mobile'],
    ['Tablet', 'Tablet'],
] as const;

/**
 * One expandable row per administrator, with that person's device sessions
 * nested inside.
 *
 * Grouping happens here rather than in SQL because a paginated list of sessions
 * would split one administrator's devices across pages — ten people on four
 * devices each is forty cards, which is what this replaces. The window is
 * bounded by the date filter instead, so the browser never holds more than a few
 * hundred rows.
 */
export function AdminActivitySessionsPage() {
    const [days, setDays] = React.useState<string>('7');
    const [search, setSearch] = React.useState('');
    const [deviceFilter, setDeviceFilter] = React.useState<string>('ALL');
    const [failuresOnly, setFailuresOnly] = React.useState(false);
    const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

    // `since` is the one filter the server applies. The rest narrow a window
    // already in memory, which keeps filter changes instant and avoids a round
    // trip per keystroke.
    const since = React.useMemo(() => {
        if (days === '') {
            return undefined;
        }
        const from = new Date();
        from.setDate(from.getDate() - Number(days));
        return from.toISOString();
    }, [days]);

    const { data, isLoading } = useQuery({
        queryKey: ['admin-activity-sessions', since],
        queryFn: () =>
            api.query(getAdminActivitySessionsDocument, { take: SESSION_FETCH_LIMIT, since }),
    });

    const sessions: AdminActivitySessionRow[] = (data as any)?.adminActivitySessions?.items ?? [];
    const groups = React.useMemo(
        () => groupByAdmin(sessions, { search, deviceFilter, failuresOnly }),
        [sessions, search, deviceFilter, failuresOnly],
    );

    const toggle = (key: string) =>
        setExpanded(current => {
            const next = new Set(current);
            if (!next.delete(key)) {
                next.add(key);
            }
            return next;
        });

    const hasFilters = search.trim() !== '' || deviceFilter !== 'ALL' || failuresOnly;

    return (
        <Page pageId="admin-activity-sessions">
            <PageTitle>Work Sessions</PageTitle>
            <div className="space-y-4 px-4 pb-6">
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="outline" render={<Link to="/admin-activity" />}>
                        <ChevronLeft className="mr-1 h-4 w-4" />
                        All activity
                    </Button>
                    <div className="relative min-w-[200px] flex-1">
                        <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Filter by administrator…"
                            className="bg-background w-full rounded border py-1.5 pl-8 pr-2 text-sm"
                        />
                    </div>
                    <SelectFilter value={days} onChange={setDays} options={DATE_RANGES} />
                    <SelectFilter
                        value={deviceFilter}
                        onChange={setDeviceFilter}
                        options={DEVICE_FILTERS}
                    />
                    <Button
                        size="sm"
                        variant={failuresOnly ? 'default' : 'outline'}
                        onClick={() => setFailuresOnly(value => !value)}
                    >
                        <AlertTriangle className="mr-1 h-4 w-4" />
                        Has failures
                    </Button>
                    {hasFilters && (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                                setSearch('');
                                setDeviceFilter('ALL');
                                setFailuresOnly(false);
                            }}
                        >
                            <X className="mr-1 h-4 w-4" />
                            Clear
                        </Button>
                    )}
                </div>

                {isLoading ? (
                    <div className="flex justify-center p-10">
                        <Spinner />
                    </div>
                ) : groups.length === 0 ? (
                    <Card>
                        <CardContent className="text-muted-foreground py-16 text-center text-sm">
                            {hasFilters
                                ? 'No sessions match these filters.'
                                : 'No work sessions recorded in this period.'}
                        </CardContent>
                    </Card>
                ) : (
                    <Card>
                        <CardContent className="divide-border divide-y p-0">
                            {groups.map(group => (
                                <AdminGroupRow
                                    key={group.key}
                                    group={group}
                                    isExpanded={expanded.has(group.key)}
                                    onToggle={() => toggle(group.key)}
                                />
                            ))}
                        </CardContent>
                    </Card>
                )}

                <div className="text-muted-foreground text-xs">
                    {groups.length} administrator{groups.length === 1 ? '' : 's'} ·{' '}
                    {groups.reduce((sum, g) => sum + g.sessions.length, 0)} sessions
                </div>
            </div>
        </Page>
    );
}

interface AdminGroup {
    key: string;
    adminName: string;
    sessions: AdminActivitySessionRow[];
    actionCount: number;
    errorCount: number;
    lastActiveAt: string;
}

/**
 * Buckets sessions by administrator, applying the in-memory filters first so a
 * person whose every session is filtered out disappears entirely rather than
 * showing as an empty row.
 *
 * Keyed on `adminId` where present and falling back to the snapshotted name, so
 * a deleted administrator still groups into one row instead of scattering.
 */
function groupByAdmin(
    sessions: AdminActivitySessionRow[],
    filters: { search: string; deviceFilter: string; failuresOnly: boolean },
): AdminGroup[] {
    const search = filters.search.trim().toLowerCase();
    const matching = sessions.filter(session => {
        if (search && !session.adminName.toLowerCase().includes(search)) {
            return false;
        }
        if (filters.failuresOnly && session.errorCount === 0) {
            return false;
        }
        if (filters.deviceFilter !== 'ALL') {
            // Device type is derived from the user agent in the browser, so this
            // filter can only judge sessions whose UA was captured. Sessions
            // predating device capture have none and are excluded rather than
            // guessed at.
            const device = parseUserAgent(session.userAgent);
            if (device?.deviceType !== filters.deviceFilter) {
                return false;
            }
        }
        return true;
    });

    const byAdmin = new Map<string, AdminGroup>();
    for (const session of matching) {
        const key = session.adminId ? `id:${session.adminId}` : `name:${session.adminName}`;
        const existing = byAdmin.get(key);
        if (existing) {
            existing.sessions.push(session);
            existing.actionCount += session.actionCount;
            existing.errorCount += session.errorCount;
            if (session.endedAt > existing.lastActiveAt) {
                existing.lastActiveAt = session.endedAt;
            }
            continue;
        }
        byAdmin.set(key, {
            key,
            adminName: session.adminName,
            sessions: [session],
            actionCount: session.actionCount,
            errorCount: session.errorCount,
            lastActiveAt: session.endedAt,
        });
    }

    const groups = [...byAdmin.values()];
    for (const group of groups) {
        group.sessions.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    }
    return groups.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : -1));
}

function AdminGroupRow(props: {
    group: AdminGroup;
    isExpanded: boolean;
    onToggle: () => void;
}) {
    const { group, isExpanded, onToggle } = props;
    const deviceCount = new Set(
        group.sessions.map(session => session.userAgent ?? session.sessionId),
    ).size;

    return (
        <div>
            <button
                type="button"
                onClick={onToggle}
                className="hover:bg-muted/50 flex w-full items-center gap-3 px-4 py-3 text-left transition"
            >
                {isExpanded ? (
                    <ChevronDown className="text-muted-foreground h-4 w-4 shrink-0" />
                ) : (
                    <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
                )}
                <span className="flex-1 font-semibold">{group.adminName}</span>
                {group.errorCount > 0 && (
                    <Badge variant="destructive" className="text-xs">
                        {group.errorCount} failed
                    </Badge>
                )}
                <span className="text-muted-foreground text-xs">
                    {deviceCount} device{deviceCount === 1 ? '' : 's'} · {group.actionCount} action
                    {group.actionCount === 1 ? '' : 's'} · {formatRelative(group.lastActiveAt)}
                </span>
            </button>

            {isExpanded && (
                <div className="bg-muted/20 divide-border/60 divide-y border-t">
                    {group.sessions.map(session => (
                        <Link
                            key={session.sessionId}
                            to="/admin-activity/sessions/$sessionId"
                            params={{ sessionId: session.sessionId }}
                            className="hover:bg-muted/60 block px-4 py-3 pl-11 transition"
                        >
                            <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                                <DeviceLine userAgent={session.userAgent} />
                                <span className="flex items-center gap-1.5">
                                    <Clock className="h-3.5 w-3.5" />
                                    {new Date(session.startedAt).toLocaleString()}
                                    {' → '}
                                    {new Date(session.endedAt).toLocaleTimeString()}
                                </span>
                                {session.ipAddress && (
                                    <span className="flex items-center gap-1.5 font-mono">
                                        <Globe className="h-3.5 w-3.5" />
                                        {session.ipAddress}
                                    </span>
                                )}
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                <Badge variant="secondary" className="text-xs">
                                    {session.actionCount} action
                                    {session.actionCount === 1 ? '' : 's'}
                                </Badge>
                                {session.errorCount > 0 && (
                                    <Badge variant="destructive" className="text-xs">
                                        {session.errorCount} failed
                                    </Badge>
                                )}
                                {session.entityTypes.map(entityType => (
                                    <Badge key={entityType} variant="outline" className="text-xs">
                                        {entityType}
                                    </Badge>
                                ))}
                            </div>
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
}

function SelectFilter(props: {
    value: string;
    onChange: (value: string) => void;
    options: ReadonlyArray<readonly [string, string]>;
}) {
    return (
        <select
            value={props.value}
            onChange={e => props.onChange(e.target.value)}
            className="bg-background rounded border py-1.5 pl-2 pr-6 text-sm"
        >
            {props.options.map(([value, label]) => (
                <option key={value} value={value}>
                    {label}
                </option>
            ))}
        </select>
    );
}

function formatRelative(iso: string): string {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    if (minutes < 2) {
        return 'active now';
    }
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * Renders the device fingerprint for a session. Titled with the raw UA so the
 * source of the interpretation is always one hover away — the parser guesses,
 * and the header does not.
 */
function DeviceLine(props: { userAgent: string | null }) {
    const device = parseUserAgent(props.userAgent);
    if (!device) {
        return null;
    }
    return (
        <div className="flex items-center gap-1.5" title={props.userAgent ?? undefined}>
            <DeviceIcon type={device.deviceType} />
            <span>
                {device.browser} · {device.os} · {device.deviceType}
            </span>
        </div>
    );
}

function DeviceIcon(props: { type: DeviceInfo['deviceType'] }) {
    if (props.type === 'Mobile') {
        return <Smartphone className="h-3.5 w-3.5" />;
    }
    if (props.type === 'Tablet') {
        return <Tablet className="h-3.5 w-3.5" />;
    }
    return <Laptop className="h-3.5 w-3.5" />;
}

export function AdminActivitySessionDetailPage() {
    const { sessionId } = useParams({ strict: false }) as { sessionId: string };

    const { data, isLoading } = useQuery({
        queryKey: ['admin-activity-session-timeline', sessionId],
        queryFn: () => api.query(getAdminActivitySessionTimelineDocument, { sessionId }),
    });

    const rows: AdminActivityLogRow[] = (data as any)?.adminActivitySessionTimeline ?? [];
    const admin = rows[0]?.adminName ?? 'Session';

    return (
        <Page pageId="admin-activity-session-detail">
            <PageTitle>{admin}</PageTitle>
            <div className="space-y-4 px-4 pb-6">
                <Button size="sm" variant="outline" render={<Link to="/admin-activity/sessions" />}>
                    <ChevronLeft className="mr-1 h-4 w-4" />
                    All sessions
                </Button>

                {isLoading ? (
                    <div className="flex justify-center p-10">
                        <Spinner />
                    </div>
                ) : rows.length === 0 ? (
                    <Card>
                        <CardContent className="text-muted-foreground py-16 text-center text-sm">
                            Nothing recorded for this session.
                        </CardContent>
                    </Card>
                ) : (
                    <Card>
                        <CardContent className="divide-border divide-y py-0">
                            {rows.map((row, i) => {
                                // Idle gaps are the shape of a working day: they show
                                // where someone stopped, which a flat list hides.
                                const gap = i > 0 ? formatGap(row.createdAt, rows[i - 1].createdAt) : null;
                                return (
                                    <React.Fragment key={row.id}>
                                        {gap && (
                                            <div className="text-muted-foreground py-2 text-center text-xs">
                                                — {gap} —
                                            </div>
                                        )}
                                        <ActivityRow row={row} hideAdmin />
                                    </React.Fragment>
                                );
                            })}
                        </CardContent>
                    </Card>
                )}
            </div>
        </Page>
    );
}

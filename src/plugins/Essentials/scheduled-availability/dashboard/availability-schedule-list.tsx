import { useMutation } from '@tanstack/react-query';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AnyRoute,
    api,
    Badge,
    BulkActionComponent,
    Button,
    DataTableBulkActionItem,
    DetailPageButton,
    Link,
    ListPage,
    PageActionBarRight,
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
    SheetTrigger,
    Switch,
    toast,
    usePaginatedList,
    VendureImage,
} from '@vendure/dashboard';
import { AlertTriangle, ClipboardList, PanelLeftOpen, Pause, Play, Plus, Trash2 } from 'lucide-react';
import React, { useRef, useState } from 'react';
import {
    describeLifecycle,
    describeReportType,
    describeSchedule,
    findScheduleWarning,
    formatInstantShort,
    isSpentOneOff,
    formatRelative,
    RUN_STATUS_META,
} from './format';
import {
    AvailabilityScheduleRow,
    deleteAvailabilityScheduleDocument,
    getAvailabilitySchedulesDocument,
    setAvailabilityScheduleEnabledDocument,
} from './queries';
import { RunHistoryTable } from './run-history-table';

/**
 * Columns whose only job is to feed a custom cell renderer.
 *
 * The Dashboard rewrites the list document to select only the fields backing
 * *visible* columns, so a cell that reads `row.original.disableCron` while the
 * `disableCron` column is hidden would read `undefined`. Declaring the fields as
 * dependencies keeps them in the query regardless of column visibility.
 */
const SCHEDULE_SHAPE_FIELDS = [
    'mode',
    'runAt',
    'action',
    'disableCron',
    'enableCron',
    'timezone',
    'activeFrom',
    'activeUntil',
    'nextRun',
    'latestRun',
    'isEnabled',
] as const;

/**
 * Columns shown before the admin touches the column picker. Everything else the
 * query selects stays available behind the picker, which is the point of moving
 * to the framework table in the first place.
 *
 * Typed as a plain Record rather than inline: inline, TypeScript infers the
 * generic for `additionalColumns` from these keys as well, and then rejects the
 * additional-columns object for "missing" the ones that are real query fields.
 */
const DEFAULT_VISIBILITY: Record<string, boolean> = {
    targetName: true,
    whatItDoes: true,
    isEnabled: true,
    latestRun: true,
};

export function AvailabilityScheduleListPage({ route }: Readonly<{ route: AnyRoute }>) {
    const [deleteTarget, setDeleteTarget] = useState<AvailabilityScheduleRow | null>(null);
    // The delete confirmation renders *outside* the table, so `usePaginatedList`
    // is unreachable from it -- that hook throws when no PaginatedListDataTable
    // is above it. `registerRefresher` is the framework's answer: the table hands
    // its refetch function out, and we keep it in a ref.
    const refreshList = useRef<() => void>(() => undefined);

    return (
        <>
            <ListPage
                pageId="availability-schedule-list"
                route={route}
                registerRefresher={refresher => {
                    refreshList.current = refresher;
                }}
                title="Scheduled Availability"
                listQuery={getAvailabilitySchedulesDocument}
                defaultSort={[{ id: 'createdAt', desc: true }]}
                // `label` is the only text column on the table. Target names live on
                // Product/Collection, which this list query never joins, so widening
                // the search to them would mean promising a search we cannot run.
                //
                // The empty-term guard is not a micro-optimisation. `contains: ''`
                // becomes `label LIKE '%%'`, and NULL LIKE anything is NULL, not
                // true -- so an untouched search box silently hid every schedule
                // without a label. Most schedules have none: the label is optional
                // and the Target cell falls back to a generated name.
                onSearchTermChange={searchTerm =>
                    searchTerm.trim() ? { label: { contains: searchTerm } } : {}
                }
                facetedFilters={{
                    isEnabled: {
                        title: 'State',
                        options: [
                            { label: 'Active', value: true },
                            { label: 'Paused', value: false },
                        ],
                    },
                    targetType: {
                        title: 'Target',
                        options: [
                            { label: 'Products', value: 'Product' },
                            { label: 'Collections', value: 'Collection' },
                        ],
                    },
                    mode: {
                        title: 'Type',
                        options: [
                            { label: 'One-off', value: 'ONE_OFF' },
                            { label: 'Recurring', value: 'RECURRING' },
                        ],
                    },
                    // No channel facet: the list is already scoped to the active
                    // channel by the server, so the channel switcher in the header
                    // is the one and only place that choice is made.
                }}
                customizeColumns={{
                    targetName: {
                        header: 'Target',
                        meta: {
                            // `kind` and `reportType` decide whether this cell draws
                            // a thumbnail or the report icon, so they have to survive
                            // the admin hiding the Kind and Report Type columns.
                            dependencies: [
                                'kind',
                                'reportType',
                                'targetType',
                                'targetId',
                                'targetAsset',
                                'label',
                            ],
                        },
                        cell: ({ row }) => <TargetCell row={row.original as AvailabilityScheduleRow} />,
                    },
                    // Fetched only to feed the Target cell's thumbnail. Without
                    // `disabled` it becomes a column of its own, and a stale saved
                    // column-visibility setting can make it visible again -- which
                    // is how "Channel id" and "Target Asset" both leaked into view.
                    targetAsset: { meta: { disabled: true } },
                    isEnabled: {
                        header: 'State',
                        meta: { dependencies: [...SCHEDULE_SHAPE_FIELDS] },
                        cell: ({ row }) => <StateCell row={row.original as AvailabilityScheduleRow} />,
                    },
                    latestRun: {
                        header: 'Last run',
                        cell: ({ row }) => (
                            <LastRunCell row={row.original as AvailabilityScheduleRow} />
                        ),
                    },
                    nextRun: {
                        header: 'Next run',
                        cell: ({ row }) => {
                            const { nextRun } = row.original as AvailabilityScheduleRow;
                            if (!nextRun) {
                                return <span className="text-muted-foreground text-xs">None</span>;
                            }
                            return (
                                <span className="whitespace-nowrap text-sm">
                                    {formatInstantShort(nextRun.dueAt)}
                                </span>
                            );
                        },
                    },
                    createdByAdmin: {
                        header: 'Created by',
                        cell: ({ row }) => {
                            const admin = (row.original as AvailabilityScheduleRow).createdByAdmin;
                            return (
                                <span className="whitespace-nowrap text-sm">
                                    {admin ? `${admin.firstName} ${admin.lastName}` : 'Unknown'}
                                </span>
                            );
                        },
                    },
                }}
                additionalColumns={{
                    whatItDoes: {
                        header: 'What it does',
                        meta: { dependencies: [...SCHEDULE_SHAPE_FIELDS] },
                        cell: ({ row }) => (
                            <WhatItDoesCell row={row.original as AvailabilityScheduleRow} />
                        ),
                    },
                }}
                defaultColumnOrder={['targetName', 'whatItDoes', 'isEnabled', 'latestRun']}
                defaultVisibility={DEFAULT_VISIBILITY}
                rowActions={[
                    {
                        label: 'Delete',
                        onClick: row => setDeleteTarget(row.original as AvailabilityScheduleRow),
                    },
                ]}
                bulkActions={[
                    [{ component: ResumeSchedulesBulkAction }, { component: PauseSchedulesBulkAction }],
                    {
                        label: 'Danger zone',
                        actions: [{ component: DeleteSchedulesBulkAction }],
                    },
                ]}
            >
                <PageActionBarRight>
                    {/* Creation is a page, not a dialog -- the same shape as
                        "New Collection" and "New Product". `./new` resolves to
                        /availability-schedules/new, which the $id route handles. */}
                    <Button render={<Link to="./new" />}>
                        <Plus className="mr-2 h-4 w-4" />
                        New schedule
                    </Button>
                </PageActionBarRight>
            </ListPage>

            <DeleteScheduleDialog
                target={deleteTarget}
                onClose={() => setDeleteTarget(null)}
                onDeleted={() => refreshList.current()}
            />
        </>
    );
}

function TargetCell({ row }: Readonly<{ row: AvailabilityScheduleRow }>) {
    const isReport = row.kind === 'REPORT';
    return (
        <div className="flex items-center gap-3">
            {isReport ? (
                /* A report has no Product or Collection behind it, so the server
                   sets targetAsset to null on purpose. Feeding that null to
                   VendureImage draws its "missing asset" placeholder, which reads
                   as a broken product image rather than "this kind never has one",
                   so reports get a fixed icon instead. */
                <div className="bg-muted text-muted-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded">
                    <ClipboardList className="h-5 w-5" />
                </div>
            ) : (
                /* VendureImage, not a raw img: the asset URL is only absolute once
                   core's AssetInterceptor has rewritten it, and this component knows
                   how to append the preset and focal point to it. */
                <VendureImage
                    asset={row.targetAsset}
                    preset="tiny"
                    className="h-10 w-10 shrink-0 rounded object-cover"
                />
            )}
            <div className="min-w-0">
                <DetailPageButton
                    id={row.id}
                    label={row.targetName ?? `${row.targetType} #${String(row.targetId)}`}
                />
                <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    {/* targetType is null on reports, which left the subtitle as a
                        bare "· label". Reports describe what they send instead. */}
                    <span>{isReport ? describeReportType(row.reportType) : row.targetType}</span>
                    {!isReport && !row.targetName && (
                        <Badge variant="destructive" className="px-1 py-0 text-[10px]">
                            deleted
                        </Badge>
                    )}
                    {/* On a report targetName already *is* the label, so repeating
                        it here would print the same word twice. */}
                    {!isReport && row.label && <span className="truncate">· {row.label}</span>}
                </div>
            </div>
        </div>
    );
}

function WhatItDoesCell({ row }: Readonly<{ row: AvailabilityScheduleRow }>) {
    const warning = findScheduleWarning(row);
    return (
        <div className="max-w-xs">
            <div className="flex items-start gap-1.5 text-sm">
                <span>{describeSchedule(row)}</span>
                {warning && (
                    <AlertTriangle
                        className="text-warning mt-0.5 h-3.5 w-3.5 shrink-0"
                        aria-label={warning}
                    />
                )}
            </div>
            {row.nextRun && (
                <div className="text-muted-foreground text-xs">
                    Next {formatRelative(row.nextRun.dueAt)} · {formatInstantShort(row.nextRun.dueAt)}
                </div>
            )}
        </div>
    );
}

function StateCell({ row }: Readonly<{ row: AvailabilityScheduleRow }>) {
    const { refetchPaginatedList } = usePaginatedList();
    const lifecycle = describeLifecycle(row);
    const spent = isSpentOneOff(row);

    const toggleEnabled = useMutation({
        mutationFn: (isEnabled: boolean) =>
            api.mutate(setAvailabilityScheduleEnabledDocument, { id: row.id, isEnabled }),
        onSuccess: (_result, isEnabled) => {
            toast.success(isEnabled ? 'Schedule resumed' : 'Schedule paused');
            refetchPaginatedList();
        },
        onError: () => toast.error('Could not change the schedule state'),
    });

    return (
        <div className="flex items-center gap-2">
            <Switch
                checked={row.isEnabled}
                disabled={spent}
                onCheckedChange={checked => toggleEnabled.mutate(checked)}
                aria-label={
                    spent
                        ? 'This one-off rule has already run — pausing it would change nothing'
                        : row.isEnabled
                          ? 'Pause this rule'
                          : 'Resume this rule'
                }
            />
            <Badge variant={lifecycle.variant}>{lifecycle.label}</Badge>
        </div>
    );
}

/**
 * The last run, and a way into the full history.
 *
 * A Sheet rather than an expanded row: the framework DataTable renders only
 * cells, with no hook for a detail panel beneath a row, so inline expansion
 * would mean forking it. Core hits the same wall on the Collections list and
 * answers it the same way -- "22 variants" opens a sheet.
 */
function LastRunCell({ row }: Readonly<{ row: AvailabilityScheduleRow }>) {
    const meta = row.latestRun ? RUN_STATUS_META[row.latestRun.status] : null;
    return (
        <Sheet>
            <SheetTrigger
                render={
                    <Button variant="ghost" size="sm" className="h-auto justify-start py-1 text-left" />
                }
            >
                <div className="whitespace-nowrap">
                    {meta && row.latestRun ? (
                        <>
                            <Badge variant={meta.variant}>{meta.label}</Badge>
                            <div className="text-muted-foreground text-xs">
                                {formatInstantShort(row.latestRun.executedAt)}
                            </div>
                        </>
                    ) : (
                        <span className="text-muted-foreground text-xs">Never run</span>
                    )}
                </div>
                <PanelLeftOpen className="ml-2 h-4 w-4 shrink-0 opacity-60" />
            </SheetTrigger>
            <SheetContent className="min-w-[90vw] lg:min-w-[800px]">
                <SheetHeader>
                    <SheetTitle>
                        Run history —{' '}
                        {row.targetName ?? `${row.targetType} #${String(row.targetId)}`}
                    </SheetTitle>
                    <SheetDescription>
                        Every occurrence this rule has produced, newest first. Executed rows are
                        never rewritten, so this is the record of what actually happened.
                    </SheetDescription>
                </SheetHeader>
                <div className="overflow-x-auto px-4">
                    <RunHistoryTable scheduleId={row.id} />
                </div>
            </SheetContent>
        </Sheet>
    );
}

function DeleteScheduleDialog({
    target,
    onClose,
    onDeleted,
}: Readonly<{
    target: AvailabilityScheduleRow | null;
    onClose: () => void;
    onDeleted: () => void;
}>) {
    const removeSchedule = useMutation({
        mutationFn: (id: string) => api.mutate(deleteAvailabilityScheduleDocument, { id }),
        onSuccess: () => {
            toast.success('Schedule deleted');
            onDeleted();
            onClose();
        },
        onError: () => {
            toast.error('Could not delete the schedule');
            onClose();
        },
    });

    return (
        <AlertDialog open={!!target} onOpenChange={open => !open && onClose()}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>Delete this schedule?</AlertDialogTitle>
                    <AlertDialogDescription>
                        {target && (
                            <>
                                The rule for{' '}
                                <strong>
                                    {target.targetName ??
                                        `${target.targetType} #${String(target.targetId)}`}
                                </strong>{' '}
                                and its entire run history will be removed. This cannot be undone —
                                to stop it firing without losing the history, pause it instead.
                            </>
                        )}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => target && removeSchedule.mutate(target.id)}>
                        Delete
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

/**
 * The API pauses one rule per call, so these fan out client-side.
 *
 * `Promise.allSettled` rather than `Promise.all`: one rejected row should not
 * hide the fact that the other nine succeeded, and the table has to be refetched
 * either way to show what actually changed.
 */
function useBulkSetEnabled(isEnabled: boolean) {
    const { refetchPaginatedList } = usePaginatedList();
    return useMutation({
        mutationFn: async (ids: string[]) => {
            const results = await Promise.allSettled(
                ids.map(id => api.mutate(setAvailabilityScheduleEnabledDocument, { id, isEnabled })),
            );
            return results.filter(result => result.status === 'rejected').length;
        },
        onSuccess: (failureCount, ids) => {
            const verb = isEnabled ? 'resumed' : 'paused';
            if (failureCount) {
                toast.error(`${failureCount} of ${ids.length} could not be ${verb}`);
            } else {
                toast.success(`${ids.length} ${ids.length === 1 ? 'schedule' : 'schedules'} ${verb}`);
            }
            refetchPaginatedList();
        },
    });
}

const PauseSchedulesBulkAction: BulkActionComponent<any> = ({ selection, table }) => {
    const setEnabled = useBulkSetEnabled(false);
    return (
        <DataTableBulkActionItem
            label="Pause"
            icon={Pause}
            onClick={() => {
                setEnabled.mutate(selection.map(row => row.id));
                table.resetRowSelection();
            }}
        />
    );
};

const ResumeSchedulesBulkAction: BulkActionComponent<any> = ({ selection, table }) => {
    const setEnabled = useBulkSetEnabled(true);
    return (
        <DataTableBulkActionItem
            label="Resume"
            icon={Play}
            onClick={() => {
                setEnabled.mutate(selection.map(row => row.id));
                table.resetRowSelection();
            }}
        />
    );
};

const DeleteSchedulesBulkAction: BulkActionComponent<any> = ({ selection, table }) => {
    const { refetchPaginatedList } = usePaginatedList();
    const removeSchedules = useMutation({
        mutationFn: async (ids: string[]) => {
            const results = await Promise.allSettled(
                ids.map(id => api.mutate(deleteAvailabilityScheduleDocument, { id })),
            );
            return results.filter(result => result.status === 'rejected').length;
        },
        onSuccess: (failureCount, ids) => {
            if (failureCount) {
                toast.error(`${failureCount} of ${ids.length} could not be deleted`);
            } else {
                toast.success(`${ids.length} deleted`);
            }
            refetchPaginatedList();
        },
    });

    return (
        <DataTableBulkActionItem
            label="Delete"
            icon={Trash2}
            className="text-destructive"
            confirmationText="This removes the selected rules and their entire run history. To stop them firing without losing the history, pause them instead."
            onClick={() => {
                removeSchedules.mutate(selection.map(row => row.id));
                table.resetRowSelection();
            }}
        />
    );
};

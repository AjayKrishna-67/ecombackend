import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    api,
    Badge,
    Button,
    Spinner,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    toast,
} from '@vendure/dashboard';
import { Ban } from 'lucide-react';
import React from 'react';
import { describeAction, formatInstant, RUN_STATUS_META } from './format';
import {
    AvailabilityRunRow,
    cancelAvailabilityScheduleRunDocument,
    getAvailabilityScheduleRunsDocument,
} from './queries';

/**
 * Runs are executed by the worker process, which has no channel back to this
 * browser. Without polling the table would sit on a stale snapshot while the
 * status silently changed in the database -- which is the exact question this
 * table is open to answer.
 */
const RUN_POLL_INTERVAL_MS = 10_000;

/** The outcome detail the service records but nothing displayed before. */
function describeOutcome(run: AvailabilityRunRow): string {
    return run.lastError ?? run.note ?? '—';
}

export function RunHistoryTable({
    scheduleId,
    onRunsChanged,
}: Readonly<{ scheduleId: string; onRunsChanged?: () => void }>) {
    const queryClient = useQueryClient();
    const runsKey = ['availability-schedule-runs', scheduleId];

    const { data, isLoading } = useQuery({
        queryKey: runsKey,
        refetchInterval: RUN_POLL_INTERVAL_MS,
        queryFn: () => api.query(getAvailabilityScheduleRunsDocument, { scheduleId }),
    });
    const runs: AvailabilityRunRow[] = (data as any)?.availabilityScheduleRuns?.items ?? [];

    const cancelRun = useMutation({
        mutationFn: (runId: string) => api.mutate(cancelAvailabilityScheduleRunDocument, { runId }),
        onSuccess: () => {
            toast.success('Run cancelled');
            void queryClient.invalidateQueries({ queryKey: runsKey });
            onRunsChanged?.();
        },
        onError: () => toast.error('Could not cancel the run'),
    });

    if (isLoading) {
        return (
            <div className="flex justify-center p-6">
                <Spinner />
            </div>
        );
    }

    if (runs.length === 0) {
        return (
            <p className="text-muted-foreground py-6 text-center text-sm">
                No runs yet. Occurrences are materialised up to 48 hours ahead by the sweep, so a
                rule due further out shows nothing here until then.
            </p>
        );
    }

    return (
        <div className="overflow-x-auto">
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>Due</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead>Result</TableHead>
                        <TableHead>Executed</TableHead>
                        <TableHead>Detail</TableHead>
                        <TableHead className="text-right" />
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {runs.map(run => {
                        const meta = RUN_STATUS_META[run.status];
                        return (
                            <TableRow key={run.id}>
                                <TableCell className="text-sm whitespace-nowrap">
                                    {formatInstant(run.dueAt)}
                                </TableCell>
                                <TableCell className="text-sm">
                                    {describeAction(run.action)}
                                </TableCell>
                                <TableCell className="whitespace-nowrap">
                                    <Badge variant={meta.variant} title={meta.hint}>
                                        {meta.label}
                                    </Badge>
                                    {run.attempts > 0 && (
                                        <span className="text-muted-foreground ml-2 text-xs">
                                            ×{run.attempts}
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell className="text-sm whitespace-nowrap">
                                    {formatInstant(run.executedAt)}
                                </TableCell>
                                <TableCell className="text-muted-foreground max-w-md text-xs">
                                    {describeOutcome(run)}
                                </TableCell>
                                <TableCell className="text-right">
                                    {run.status === 'PENDING' && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            title="Cancel this occurrence"
                                            onClick={() => cancelRun.mutate(run.id)}
                                        >
                                            <Ban className="h-4 w-4" />
                                        </Button>
                                    )}
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </div>
    );
}

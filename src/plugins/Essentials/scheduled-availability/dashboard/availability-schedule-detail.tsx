import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { NEW_ENTITY_PATH } from '@vendure/dashboard';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    api,
    Badge,
    Button,
    Page,
    PageActionBar,
    PageActionBarRight,
    PageBlock,
    PageLayout,
    PageTitle,
    Spinner,
    Switch,
    toast,
} from '@vendure/dashboard';
import { Play, Save, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import { AvailabilityScheduleNewPage } from './availability-schedule-new';
import {
    describeAction,
    describeLifecycle,
    formatInstant,
    formatRelative,
    isSpentOneOff,
    RUN_STATUS_META,
} from './format';
import {
    AvailabilityScheduleRow,
    deleteAvailabilityScheduleDocument,
    getAvailabilityScheduleDocument,
    runAvailabilityScheduleNowDocument,
    setAvailabilityScheduleEnabledDocument,
} from './queries';
import { RunHistoryTable } from './run-history-table';
import { ScheduleFormFields } from './schedule-form-fields';
import { useScheduleForm } from './use-schedule-form';

export function AvailabilityScheduleDetailPage() {
    const params = useParams({ strict: false }) as { id?: string };
    const scheduleId = params.id ?? '';

    // `/availability-schedules/new` is served by this same $id route, exactly as
    // core serves `/collections/new` from its own $id route. Reusing the route
    // rather than registering a second one removes any question of which pattern
    // wins the match for the literal segment "new".
    if (scheduleId === NEW_ENTITY_PATH) {
        return <AvailabilityScheduleNewPage />;
    }

    return <ScheduleDetail scheduleId={scheduleId} />;
}

/**
 * One schedule: the editable rule in the main column, its live state in the
 * side column, its run history underneath.
 *
 * The detail page *is* the edit form, which is how the dashboard treats every
 * other entity -- a Collection is edited on `/collections/$id`, not in a dialog
 * launched from it. Save sits in the action bar beside Run now and Delete.
 */
function ScheduleDetail({ scheduleId }: Readonly<{ scheduleId: string }>) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [confirmDelete, setConfirmDelete] = useState(false);

    const detailKey = ['availability-schedule', scheduleId];
    const { data, isLoading } = useQuery({
        queryKey: detailKey,
        enabled: !!scheduleId,
        // Keeps the state blocks live while the admin has the form open. The form
        // itself does not reseed on these ticks -- useScheduleForm keys its
        // seeding on the schedule id, not the object -- so a poll arriving
        // mid-edit cannot overwrite what has been typed.
        refetchInterval: 30_000,
        queryFn: () => api.query(getAvailabilityScheduleDocument, { id: scheduleId }),
    });
    const schedule: AvailabilityScheduleRow | null = (data as any)?.availabilitySchedule ?? null;

    const invalidate = () => {
        void queryClient.invalidateQueries({ queryKey: detailKey });
    };

    const { form, setForm, occurrences, previewError, noPatternChosen, canSave, save } =
        useScheduleForm({
            editing: schedule,
            isActive: !!schedule,
            onSaved: () => {
                invalidate();
                void queryClient.invalidateQueries({
                    queryKey: ['availability-schedule-runs', scheduleId],
                });
            },
        });

    // Spread into every block: the groups share one form state, so the props
    // must stay identical across them or a field would write to a stale copy.
    // `isEditing` belongs here too -- it is what stops the Type select offering
    // a switch the server will reject.
    const fieldProps = {
        form,
        setForm,
        occurrences,
        previewError,
        noPatternChosen,
        isEditing: true,
    };

    const toggleEnabled = useMutation({
        mutationFn: (isEnabled: boolean) =>
            api.mutate(setAvailabilityScheduleEnabledDocument, { id: scheduleId, isEnabled }),
        onSuccess: (_result, isEnabled) => {
            toast.success(isEnabled ? 'Schedule resumed' : 'Schedule paused');
            invalidate();
        },
        onError: () => toast.error('Could not change the schedule state'),
    });

    const runNow = useMutation({
        mutationFn: () => api.mutate(runAvailabilityScheduleNowDocument, { id: scheduleId }),
        onSuccess: () => {
            toast.success('Triggered — watch the run history below');
            invalidate();
            void queryClient.invalidateQueries({
                queryKey: ['availability-schedule-runs', scheduleId],
            });
        },
        onError: () => toast.error('Could not run the schedule'),
    });

    const removeSchedule = useMutation({
        mutationFn: () => api.mutate(deleteAvailabilityScheduleDocument, { id: scheduleId }),
        onSuccess: () => {
            toast.success('Schedule deleted');
            void navigate({ to: '/availability-schedules' });
        },
        onError: () => {
            toast.error('Could not delete the schedule');
            setConfirmDelete(false);
        },
    });

    if (isLoading) {
        return (
            <Page pageId="availability-schedule-detail">
                <div className="flex justify-center p-12">
                    <Spinner />
                </div>
            </Page>
        );
    }

    if (!schedule) {
        return (
            <Page pageId="availability-schedule-detail">
                <PageTitle>Schedule not found</PageTitle>
                <p className="text-muted-foreground text-sm">
                    It may have been deleted, or it belongs to another channel.{' '}
                    <Link to="/availability-schedules" className="underline">
                        Back to all schedules
                    </Link>
                </p>
            </Page>
        );
    }

    const lifecycle = describeLifecycle(schedule);
    const spent = isSpentOneOff(schedule);
    const lastRunMeta = schedule.latestRun ? RUN_STATUS_META[schedule.latestRun.status] : null;
    const targetLabel = schedule.targetName ?? `${schedule.targetType} #${String(schedule.targetId)}`;

    return (
        <Page pageId="availability-schedule-detail">
            <PageTitle>{targetLabel}</PageTitle>

            <PageActionBar>
                <PageActionBarRight>
                    <Button
                        variant="outline"
                        onClick={() => runNow.mutate()}
                        disabled={runNow.isPending}
                    >
                        <Play className="mr-2 h-4 w-4" />
                        Run now
                    </Button>
                    <Button variant="outline" onClick={() => setConfirmDelete(true)}>
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                    </Button>
                    <Button disabled={!canSave} onClick={() => save.mutate()}>
                        <Save className="mr-2 h-4 w-4" />
                        Save changes
                    </Button>
                </PageActionBarRight>
            </PageActionBar>

            <PageLayout>
                {/* One block per group, matching the create page and the
                    Product/Order screens. Same section order in both, so the
                    form does not rearrange itself between creating and editing. */}
                <PageBlock column="main" blockId="what-to-schedule">
                    <ScheduleFormFields {...fieldProps} section="what" />
                </PageBlock>

                <PageBlock column="main" blockId="recipients">
                    <ScheduleFormFields {...fieldProps} section="recipients" />
                </PageBlock>

                <PageBlock column="main" blockId="when-it-runs">
                    <ScheduleFormFields {...fieldProps} section="when" />
                </PageBlock>

                <PageBlock column="main" blockId="preview" title="What will happen">
                    <ScheduleFormFields {...fieldProps} section="preview" />
                </PageBlock>

                <PageBlock column="side" blockId="details" title="Details">
                    <ScheduleFormFields {...fieldProps} section="details" />
                </PageBlock>

                <PageBlock column="main" blockId="run-history" title="Run history">
                    <RunHistoryTable scheduleId={scheduleId} onRunsChanged={invalidate} />
                </PageBlock>

                {/* Titled "Enabled" and laid out like Product's own Enabled card:
                    the control first, then one line saying what it does. The
                    lifecycle badge stays because "Enabled" and "will actually
                    fire" are not the same thing -- a rule can be enabled and
                    still be Completed, or Needs attention. */}
                <PageBlock column="side" blockId="enabled" title="Enabled">
                    <div className="flex items-center justify-between">
                        <Switch
                            checked={schedule.isEnabled}
                            disabled={spent}
                            onCheckedChange={checked => toggleEnabled.mutate(checked)}
                            aria-label={
                                spent
                                    ? 'This one-off rule has already run — pausing it would change nothing'
                                    : schedule.isEnabled
                                      ? 'Pause this rule'
                                      : 'Resume this rule'
                            }
                        />
                        <Badge variant={lifecycle.variant}>{lifecycle.label}</Badge>
                    </div>
                    <p className="text-muted-foreground mt-2 text-xs">
                        {schedule.isEnabled
                            ? 'When enabled, this rule fires on its schedule.'
                            : 'Disabled — this rule will not fire until you enable it.'}
                    </p>
                    {/* The lifecycle hint is the specific reason, and it only adds
                        something when it is not just restating the toggle. */}
                    {schedule.isEnabled && (
                        <p className="text-muted-foreground mt-1 text-xs">{lifecycle.hint}</p>
                    )}
                </PageBlock>

                <PageBlock column="side" blockId="last-run" title="Last run">
                    {lastRunMeta && schedule.latestRun ? (
                        <div>
                            <Badge variant={lastRunMeta.variant}>{lastRunMeta.label}</Badge>
                            <p className="mt-1 text-sm">
                                {formatInstant(schedule.latestRun.executedAt)}
                            </p>
                            {(schedule.latestRun.lastError ?? schedule.latestRun.note) && (
                                <p className="text-muted-foreground mt-1 text-xs">
                                    {schedule.latestRun.lastError ?? schedule.latestRun.note}
                                </p>
                            )}
                        </div>
                    ) : (
                        <p className="text-sm">Never run</p>
                    )}
                </PageBlock>

                <PageBlock column="side" blockId="next-run" title="Next run">
                    {schedule.nextRun ? (
                        <p className="text-sm">
                            {describeAction(schedule.nextRun.action)}{' '}
                            {formatRelative(schedule.nextRun.dueAt)}
                            <span className="text-muted-foreground block text-xs">
                                {formatInstant(schedule.nextRun.dueAt)}
                            </span>
                        </p>
                    ) : (
                        <p className="text-muted-foreground text-sm">Nothing materialised</p>
                    )}
                </PageBlock>

                <PageBlock column="side" blockId="created-by" title="Created by">
                    <p className="text-sm">
                        {schedule.createdByAdmin
                            ? `${schedule.createdByAdmin.firstName} ${schedule.createdByAdmin.lastName}`
                            : 'Unknown'}
                    </p>
                </PageBlock>
            </PageLayout>

            <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete this schedule?</AlertDialogTitle>
                        <AlertDialogDescription>
                            The rule and its entire run history will be removed. This cannot be
                            undone — to stop it firing without losing the history, pause it instead.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => removeSchedule.mutate()}>
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Page>
    );
}

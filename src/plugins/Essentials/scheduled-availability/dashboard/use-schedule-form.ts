import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, toast, useChannel } from '@vendure/dashboard';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildCron, CronParts, DEFAULT_CRON_PARTS, parseCron } from './cron-builder';
import {
    AvailabilityAction,
    AvailabilityScheduleMode,
    AvailabilityScheduleRow,
    AvailabilityTargetType,
    createAvailabilityScheduleDocument,
    previewAvailabilityScheduleDocument,
    ReportDateRangeMode,
    ScheduledReportType,
    ScheduleKind,
    TargetOption,
    updateAvailabilityScheduleDocument,
} from './queries';

/** Zones an Indian storefront realistically uses, plus UTC for sanity checks. */
export const TIMEZONES = [
    'Asia/Kolkata',
    'Asia/Dubai',
    'Asia/Singapore',
    'Europe/London',
    'America/New_York',
    'UTC',
] as const;

export interface ScheduleFormState {
    /**
     * Which half of the form is on screen.
     *
     * Deliberately its own field rather than a third `targetType` value: that
     * type feeds the target picker and the server's target lookup, and a
     * "Report" value there would have to be special-cased in both.
     */
    kind: ScheduleKind;
    targetType: AvailabilityTargetType;
    target: TargetOption | null;
    /** REPORT only. */
    reportType: ScheduledReportType;
    /** REPORT only. The brand; its channels resolve at run time. */
    reportSellerId: string | null;
    dateRangeMode: ReportDateRangeMode;
    /** Free text in the UI, split into numbers on save. */
    recipients: string;
    sendEnabled: boolean;
    sendParts: CronParts;
    sendAdvanced: boolean;
    sendRaw: string;
    channelId: string;
    mode: AvailabilityScheduleMode;
    /** ONE_OFF only. ISO instant, exactly as the API stores and returns it. */
    runAt: string;
    action: AvailabilityAction;
    hideEnabled: boolean;
    hideParts: CronParts;
    hideAdvanced: boolean;
    hideRaw: string;
    showEnabled: boolean;
    showParts: CronParts;
    showAdvanced: boolean;
    showRaw: string;
    timezone: string;
    label: string;
}

const EMPTY_FORM: ScheduleFormState = {
    kind: 'AVAILABILITY',
    targetType: 'Product',
    target: null,
    reportType: 'PURCHASE_LIST',
    reportSellerId: null,
    dateRangeMode: 'TODAY',
    recipients: '',
    sendEnabled: true,
    // 21:00 by default: the purchase list is compiled after the day's orders
    // close, which is when it was being downloaded by hand.
    sendParts: { ...DEFAULT_CRON_PARTS, frequency: 'DAILY', time: '21:00' },
    sendAdvanced: false,
    sendRaw: '0 21 * * *',
    channelId: '',
    mode: 'RECURRING',
    runAt: '',
    action: 'DISABLE',
    hideEnabled: true,
    hideParts: DEFAULT_CRON_PARTS,
    hideAdvanced: false,
    hideRaw: '0 22 * * *',
    showEnabled: true,
    showParts: { ...DEFAULT_CRON_PARTS, time: '06:00' },
    showAdvanced: false,
    showRaw: '0 6 * * *',
    timezone: 'Asia/Kolkata',
    label: '',
};

/**
 * One shape for both halves of the form, with the other half's fields set to
 * null rather than omitted.
 *
 * A union of two differently-shaped objects would be the honest model, but
 * gql.tada narrows the mutation's variables to a single input type and a union
 * collapses to `never` at the call site. Every field is nullable in the schema
 * anyway, so sending explicit nulls is both valid and clearer than sending
 * `undefined` -- on update it means "clear this", which is exactly what
 * switching a rule from one kind to the other should do.
 */
interface ScheduleInput {
    kind: ScheduleKind;
    targetType: AvailabilityTargetType | null;
    targetId: string | null;
    channelId: string;
    mode: AvailabilityScheduleMode;
    runAt: string | null;
    action: AvailabilityAction | null;
    disableCron: string | null;
    enableCron: string | null;
    sendCron: string | null;
    reportType: ScheduledReportType | null;
    reportSellerId: string | null;
    recipients: string[] | null;
    dateRangeMode: ReportDateRangeMode | null;
    timezone: string;
    label: string | null;
}

/**
 * Splits the recipients textarea into numbers.
 *
 * Accepts commas, spaces and newlines because admins paste from all three, and
 * strips everything that is not a digit so a pasted "+91 80563 05724" becomes
 * the "918056305724" MSG91 expects. Numbers shorter than ten digits are dropped
 * rather than sent: a truncated number is not a delivery failure, it is a
 * message delivered to a stranger.
 */
export function parseRecipients(raw: string): string[] {
    return raw
        .split(/[\s,;]+/)
        .map(entry => entry.replace(/\D/g, ''))
        .filter(entry => entry.length >= 10)
        .filter((entry, index, all) => all.indexOf(entry) === index);
}

/** Reads an existing pattern back into the builder, or falls back to raw. */
function seedCron(pattern: string | null, fallbackTime: string) {
    const parsed = parseCron(pattern);
    return {
        enabled: !!pattern,
        parts: parsed ?? { ...DEFAULT_CRON_PARTS, time: fallbackTime },
        advanced: !!pattern && !parsed,
        raw: pattern ?? '',
    };
}

interface UseScheduleFormOptions {
    /** The schedule being edited, or null when creating. */
    editing: AvailabilityScheduleRow | null;
    /**
     * Whether the form is currently on screen. The dialog passes its `open`
     * state so the form reseeds each time it is reopened; the create page passes
     * true, since mounting is already a fresh start.
     */
    isActive: boolean;
    onSaved?: (scheduleId: string) => void;
}

/**
 * All state and server traffic behind the schedule form.
 *
 * Extracted from the dialog so the create *page* and the edit *dialog* run the
 * same logic. The dashboard's own `useDetailPage` was not used here: it derives
 * a react-hook-form schema from a single entity document, and this form is not
 * that shape -- it composes two cron builders, a channel-scoped target picker,
 * and a live preview of an unsaved rule.
 */
export function useScheduleForm({ editing, isActive, onSaved }: UseScheduleFormOptions) {
    const queryClient = useQueryClient();
    const { activeChannel } = useChannel();
    const [form, setForm] = useState<ScheduleFormState>(EMPTY_FORM);

    // The detail page polls every 30 seconds to keep its state blocks live, so
    // `editing` is a fresh object on every tick. Seeding off the object identity
    // would wipe whatever the admin had half-typed each time. The id is the
    // stable thing; the values are read through a ref at seed time.
    const editingRef = useRef(editing);
    editingRef.current = editing;
    const editingId = editing?.id ?? null;

    // Channel-aware: the rule belongs to whichever channel the header switcher is
    // on. There is no channel field in the form, because there is no second
    // choice to make -- and the list would not show a rule created elsewhere.
    const activeChannelId = activeChannel?.id ? String(activeChannel.id) : '';

    useEffect(() => {
        if (!isActive) {
            return;
        }
        const editing = editingRef.current;
        if (editing) {
            const hide = seedCron(editing.disableCron, '22:00');
            const show = seedCron(editing.enableCron, '06:00');
            const send = seedCron(editing.sendCron, '21:00');
            setForm({
                kind: editing.kind,
                targetType: editing.targetType ?? 'Product',
                target: editing.targetId
                    ? {
                          id: String(editing.targetId),
                          name:
                              editing.targetName ??
                              `${editing.targetType} #${String(editing.targetId)}`,
                          asset: editing.targetAsset,
                      }
                    : null,
                reportType: editing.reportType ?? 'PURCHASE_LIST',
                reportSellerId: editing.reportSellerId ?? null,
                dateRangeMode: editing.dateRangeMode ?? 'TODAY',
                recipients: (editing.recipients ?? []).join(', '),
                sendEnabled: send.enabled,
                sendParts: send.parts,
                sendAdvanced: send.advanced,
                sendRaw: send.raw,
                channelId: String(editing.channel.id),
                mode: editing.mode,
                runAt: editing.runAt ?? '',
                action: editing.action ?? 'DISABLE',
                hideEnabled: hide.enabled,
                hideParts: hide.parts,
                hideAdvanced: hide.advanced,
                hideRaw: hide.raw,
                showEnabled: show.enabled,
                showParts: show.parts,
                showAdvanced: show.advanced,
                showRaw: show.raw,
                timezone: editing.timezone,
                label: editing.label ?? '',
            });
            return;
        }
        setForm({ ...EMPTY_FORM, channelId: activeChannelId });
        // activeChannelId is intentionally excluded: switching channel mid-edit
        // is handled by the effect below, which does not reset the other fields.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isActive, editingId]);

    // Follows the header's channel switcher. Clearing the target is deliberate --
    // it was picked from the previous channel's catalogue and the server rejects
    // a rule whose target does not exist where it runs.
    useEffect(() => {
        if (editingId || !activeChannelId) {
            return;
        }
        setForm(current =>
            current.channelId === activeChannelId
                ? current
                : { ...current, channelId: activeChannelId, target: null },
        );
    }, [activeChannelId, editingId]);

    const createInput = useMemo((): ScheduleInput | null => {
        if (!form.channelId) {
            return null;
        }
        if (form.kind === 'REPORT') {
            const sendCron = form.sendAdvanced ? form.sendRaw : buildCron(form.sendParts);
            const recipients = parseRecipients(form.recipients);
            if (!sendCron || !recipients.length || !form.reportSellerId) {
                return null;
            }
            return {
                kind: 'REPORT',
                targetType: null,
                targetId: null,
                channelId: form.channelId,
                // A report is always recurring: a one-off report is a button, not
                // a schedule, and the server rejects the combination anyway.
                mode: 'RECURRING',
                runAt: null,
                action: null,
                disableCron: null,
                enableCron: null,
                sendCron,
                reportType: form.reportType,
                reportSellerId: form.reportSellerId,
                recipients,
                dateRangeMode: form.dateRangeMode,
                timezone: form.timezone,
                label: form.label || null,
            };
        }
        if (!form.target) {
            return null;
        }
        const isRecurring = form.mode === 'RECURRING';
        const hideCron = form.hideAdvanced ? form.hideRaw : buildCron(form.hideParts);
        const showCron = form.showAdvanced ? form.showRaw : buildCron(form.showParts);
        return {
            kind: 'AVAILABILITY',
            targetType: form.targetType,
            targetId: form.target.id,
            channelId: form.channelId,
            mode: form.mode,
            runAt: isRecurring ? null : form.runAt || null,
            action: isRecurring ? null : form.action,
            disableCron: isRecurring && form.hideEnabled ? hideCron || null : null,
            enableCron: isRecurring && form.showEnabled ? showCron || null : null,
            sendCron: null,
            reportType: null,
            reportSellerId: null,
            recipients: null,
            dateRangeMode: null,
            timezone: form.timezone,
            label: form.label || null,
        };
    }, [form]);

    const { data: previewData, error: previewError } = useQuery({
        queryKey: ['availability-preview', createInput],
        enabled: isActive && !!createInput,
        retry: false,
        queryFn: () =>
            api.query(previewAvailabilityScheduleDocument, { input: createInput, count: 6 }),
    });
    const occurrences: Array<{ dueAt: string; action: AvailabilityAction }> =
        (previewData as any)?.previewAvailabilitySchedule ?? [];

    const save = useMutation({
        mutationFn: async () => {
            if (!createInput) {
                throw new Error('Pick a target and a channel first.');
            }
            if (editing) {
                // `channelId` and `kind` are both fixed at creation. The channel
                // because a rule acts inside exactly one, and the kind because
                // converting an availability rule into a report rule would leave
                // one run history mixing Hide/Show rows with Send rows,
                // describing a rule that no longer exists. Neither field appears
                // on UpdateAvailabilityScheduleInput, so sending them is a
                // GraphQL error rather than a silent no-op.
                const { channelId, kind, ...rest } = createInput;
                return api.mutate(updateAvailabilityScheduleDocument, {
                    input: { id: editing.id, ...rest },
                });
            }
            return api.mutate(createAvailabilityScheduleDocument, { input: createInput });
        },
        onSuccess: (result: any) => {
            toast.success(editing ? 'Schedule updated' : 'Schedule created');
            void queryClient.invalidateQueries({ queryKey: ['availability-schedule'] });
            const savedId = String(
                result?.createAvailabilitySchedule?.id ??
                    result?.updateAvailabilitySchedule?.id ??
                    editing?.id ??
                    '',
            );
            onSaved?.(savedId);
        },
        onError: (err: unknown) => {
            toast.error(err instanceof Error ? err.message : 'Could not save the schedule');
        },
    });

    const noPatternChosen =
        form.kind === 'AVAILABILITY' &&
        form.mode === 'RECURRING' &&
        !form.hideEnabled &&
        !form.showEnabled;

    /**
     * A pattern that is switched on but has produced nothing.
     *
     * `buildCron` returns an empty string for "on chosen days" with no days
     * ticked. Without this check the rule would save with a null cron on a side
     * the admin explicitly enabled -- a nightly close that never closes, which
     * only shows up as an absence weeks later.
     */
    const incompletePattern =
        form.kind === 'AVAILABILITY' &&
        form.mode === 'RECURRING' &&
        ((form.hideEnabled && !(form.hideAdvanced ? form.hideRaw : buildCron(form.hideParts))) ||
            (form.showEnabled && !(form.showAdvanced ? form.showRaw : buildCron(form.showParts))));

    return {
        form,
        setForm,
        occurrences,
        previewError,
        noPatternChosen,
        canSave: !!createInput && !noPatternChosen && !incompletePattern && !save.isPending,
        save,
    };
}

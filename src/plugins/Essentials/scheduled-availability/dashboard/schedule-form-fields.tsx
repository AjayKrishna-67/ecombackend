import {
    Alert,
    AlertDescription,
    api,
    Badge,
    Button,
    DateTimeInput,
    DetailFormGrid,
    Input,
    Label,
} from '@vendure/dashboard';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import React from 'react';
import { buildCron, CronBuilder } from './cron-builder';
import { describeAction, formatChannelCode, formatInstant } from './format';
import { LabelledSelect } from './labelled-select';
import {
    AvailabilityAction,
    AvailabilityScheduleMode,
    AvailabilityTargetType,
    getReportBrandsDocument,
    ReportDateRangeMode,
    ScheduledReportType,
} from './queries';
import { TargetCombobox } from './target-combobox';
import { parseRecipients, ScheduleFormState, TIMEZONES } from './use-schedule-form';

/**
 * One placeable group of fields.
 *
 * The form is split so the page can put each group in its own PageBlock and
 * choose its column, the way the Product and Order detail screens do. Rendering
 * the whole form as one block is what made this screen a single long scroll with
 * no visual hierarchy.
 */
export type ScheduleFormSection = 'what' | 'recipients' | 'when' | 'details' | 'preview';

interface ScheduleFormFieldsProps {
    form: ScheduleFormState;
    setForm: React.Dispatch<React.SetStateAction<ScheduleFormState>>;
    occurrences: Array<{ dueAt: string; action: AvailabilityAction }>;
    previewError: unknown;
    noPatternChosen: boolean;
    /** Which group to render. Required: a page always places one block at a time. */
    section: ScheduleFormSection;
    /**
     * True on the detail page. Kind is fixed at creation, so the Type select
     * must stop offering the switch rather than accept it and fail on save --
     * an option that always errors is worse than no option.
     */
    isEditing?: boolean;
}

/**
 * One group of schedule fields, with no opinion about its container.
 *
 * Kept as a single component switching on `section` rather than five exported
 * components: every group reads the same `form` and writes through the same
 * `setForm`, so splitting them into separate files would mean threading that
 * state through five prop signatures that must stay identical.
 */
export function ScheduleFormFields({
    form,
    setForm,
    occurrences,
    previewError,
    noPatternChosen,
    section,
    isEditing = false,
}: Readonly<ScheduleFormFieldsProps>) {
    const isReport = form.kind === 'REPORT';
    const parsedRecipients = parseRecipients(form.recipients);

    switch (section) {
        case 'what':
            return (
            <FormSection
                title="What to schedule"
                description={
                    isReport
                        ? 'The rule runs inside one channel and delivers a report over WhatsApp.'
                        : 'The rule runs inside one channel, against one product or collection.'
                }
            >
                <DetailFormGrid>
                    <FormRow
                        label="Type"
                        description={
                            isEditing
                                ? 'Fixed when the rule was created — a rule cannot change between availability and reporting.'
                                : undefined
                        }
                    >
                        <LabelledSelect
                            // A report rule has nothing else it could become, so
                            // the control is inert rather than showing one option.
                            disabled={isEditing && isReport}
                            value={isReport ? 'Report' : form.targetType}
                            onChange={value =>
                                setForm(f =>
                                    value === 'Report'
                                        ? { ...f, kind: 'REPORT', target: null }
                                        : {
                                              ...f,
                                              kind: 'AVAILABILITY',
                                              targetType: value as AvailabilityTargetType,
                                              // Cleared for the same reason switching
                                              // between Product and Collection clears it:
                                              // the previous pick cannot be valid for the
                                              // new type, and a stale value that looks
                                              // filled in is worse than an empty field.
                                              target: null,
                                          },
                                )
                            }
                            options={
                                isEditing
                                    ? isReport
                                        ? [{ value: 'Report', label: 'A report' }]
                                        : [
                                              { value: 'Product', label: 'A product' },
                                              { value: 'Collection', label: 'A collection' },
                                          ]
                                    : [
                                          { value: 'Product', label: 'A product' },
                                          { value: 'Collection', label: 'A collection' },
                                          { value: 'Report', label: 'A report' },
                                      ]
                            }
                        />
                    </FormRow>
                </DetailFormGrid>

                {isReport ? (
                    <>
                        <DetailFormGrid>
                            <FormRow label="Report">
                                <LabelledSelect
                                    value={form.reportType}
                                    onChange={value =>
                                        setForm(f => ({
                                            ...f,
                                            reportType: value as ScheduledReportType,
                                        }))
                                    }
                                    options={[{ value: 'PURCHASE_LIST', label: 'Purchase list' }]}
                                />
                            </FormRow>
                            <FormRow
                                label="Covering"
                                description="Which day's orders the report aggregates, read in the timezone below."
                            >
                                <LabelledSelect
                                    value={form.dateRangeMode}
                                    onChange={value =>
                                        setForm(f => ({
                                            ...f,
                                            dateRangeMode: value as ReportDateRangeMode,
                                        }))
                                    }
                                    options={[
                                        { value: 'TODAY', label: "Today's orders" },
                                        { value: 'YESTERDAY', label: "Yesterday's orders" },
                                    ]}
                                />
                            </FormRow>
                        </DetailFormGrid>

                        <FormRow
                            label="Brand to report on"
                            description="The report covers every channel of this brand — not the same as the channel this rule belongs to. Cities added to the brand later are included automatically."
                        >
                            <ReportBrandPicker
                                selected={form.reportSellerId}
                                onChange={reportSellerId =>
                                    setForm(f => ({ ...f, reportSellerId }))
                                }
                            />
                        </FormRow>
                    </>
                ) : (
                    <FormRow
                        label="Target"
                        description="Searched inside the channel you are currently in — a rule can only act on a target that exists there."
                    >
                        <TargetCombobox
                            targetType={form.targetType}
                            channelId={form.channelId}
                            value={form.target}
                            onChange={target => setForm(f => ({ ...f, target }))}
                        />
                    </FormRow>
                )}
            </FormSection>
            );
        case 'recipients':
            // Availability rules notify nobody, so this block simply is not
            // theirs -- returning null lets the page skip the card entirely
            // rather than render an empty one.
            return isReport ? (
                    <FormRow
                        label="Send to"
                        description="WhatsApp numbers with the country code. Separate several with commas or new lines."
                    >
                        <div className="space-y-1">
                            <Input
                                placeholder="918056305724, 919840089302"
                                value={form.recipients}
                                onChange={event =>
                                    setForm(f => ({ ...f, recipients: event.target.value }))
                                }
                            />
                            <p className="text-muted-foreground text-xs">
                                {parsedRecipients.length
                                    ? `${parsedRecipients.length} number${
                                          parsedRecipients.length === 1 ? '' : 's'
                                      }: ${parsedRecipients.join(', ')}`
                                    : 'No valid numbers yet.'}
                            </p>
                        </div>
                    </FormRow>
            ) : null;
        case 'when':
            return (
            <FormSection
                title="When it runs"
                description="Cron patterns are read in the timezone chosen here, not the browser's."
            >
                <DetailFormGrid>
                    {/* A report is always recurring. A one-off report is a button,
                        not a schedule, so the choice is hidden rather than shown
                        and then rejected by the server. */}
                    {!isReport && (
                        <FormRow label="How often">
                            <LabelledSelect
                                value={form.mode}
                                onChange={value =>
                                    setForm(f => ({ ...f, mode: value as AvailabilityScheduleMode }))
                                }
                                options={[
                                    { value: 'ONE_OFF', label: 'Once, at a set time' },
                                    { value: 'RECURRING', label: 'On a repeating schedule' },
                                ]}
                            />
                        </FormRow>
                    )}
                    <FormRow label="Timezone">
                        <LabelledSelect
                            value={form.timezone}
                            onChange={timezone => setForm(f => ({ ...f, timezone }))}
                            options={TIMEZONES.map(zone => ({ value: zone, label: zone }))}
                        />
                    </FormRow>
                </DetailFormGrid>

                {isReport ? (
                    <CronBuilder
                        title="When to send"
                        enabled={form.sendEnabled}
                        onEnabledChange={sendEnabled => setForm(f => ({ ...f, sendEnabled }))}
                        parts={form.sendParts}
                        onPartsChange={sendParts => setForm(f => ({ ...f, sendParts }))}
                        advanced={form.sendAdvanced}
                        rawPattern={form.sendRaw}
                        onRawPatternChange={sendRaw => setForm(f => ({ ...f, sendRaw }))}
                        onToggleAdvanced={() =>
                            setForm(f => ({
                                ...f,
                                sendAdvanced: !f.sendAdvanced,
                                sendRaw: f.sendAdvanced ? f.sendRaw : buildCron(f.sendParts),
                            }))
                        }
                    />
                ) : form.mode === 'ONE_OFF' ? (
                    <DetailFormGrid>
                        <FormRow label="When">
                            {/* The framework's own picker, not <input type="datetime-local">.
                                The native control renders in the browser's locale and zone
                                and looks nothing like the rest of the dashboard; this one
                                speaks ISO instants both ways, which also removes the
                                wall-clock/UTC conversion this form used to do by hand. */}
                            <DateTimeInput
                                name="runAt"
                                value={form.runAt}
                                onChange={next =>
                                    setForm(f => ({
                                        ...f,
                                        runAt: typeof next === 'string' ? next : '',
                                    }))
                                }
                                onBlur={() => undefined}
                                ref={() => undefined}
                            />
                        </FormRow>
                        <FormRow label="Do what">
                            <LabelledSelect
                                value={form.action}
                                onChange={value =>
                                    setForm(f => ({ ...f, action: value as AvailabilityAction }))
                                }
                                options={[
                                    { value: 'DISABLE', label: 'Hide from the shop' },
                                    { value: 'ENABLE', label: 'Show in the shop' },
                                ]}
                            />
                        </FormRow>
                    </DetailFormGrid>
                ) : (
                    <div className="grid gap-3">
                        <CronBuilder
                            title="Hide it"
                            enabled={form.hideEnabled}
                            onEnabledChange={hideEnabled => setForm(f => ({ ...f, hideEnabled }))}
                            parts={form.hideParts}
                            onPartsChange={hideParts => setForm(f => ({ ...f, hideParts }))}
                            advanced={form.hideAdvanced}
                            rawPattern={form.hideRaw}
                            onRawPatternChange={hideRaw => setForm(f => ({ ...f, hideRaw }))}
                            onToggleAdvanced={() =>
                                setForm(f => ({
                                    ...f,
                                    hideAdvanced: !f.hideAdvanced,
                                    hideRaw: f.hideAdvanced ? f.hideRaw : buildCron(f.hideParts),
                                }))
                            }
                        />
                        <CronBuilder
                            title="Show it again"
                            enabled={form.showEnabled}
                            onEnabledChange={showEnabled => setForm(f => ({ ...f, showEnabled }))}
                            parts={form.showParts}
                            onPartsChange={showParts => setForm(f => ({ ...f, showParts }))}
                            advanced={form.showAdvanced}
                            rawPattern={form.showRaw}
                            onRawPatternChange={showRaw => setForm(f => ({ ...f, showRaw }))}
                            onToggleAdvanced={() =>
                                setForm(f => ({
                                    ...f,
                                    showAdvanced: !f.showAdvanced,
                                    showRaw: f.showAdvanced ? f.showRaw : buildCron(f.showParts),
                                }))
                            }
                        />
                        {/* Alert has no "warning" variant -- only default and destructive --
                            so the severity is carried by the icon colour instead. */}
                        {form.hideEnabled && !form.showEnabled && (
                            <Alert>
                                <AlertTriangle className="text-warning h-4 w-4" />
                                <AlertDescription>
                                    This will hide the target and never show it again unless you add
                                    a &ldquo;show it again&rdquo; schedule.
                                </AlertDescription>
                            </Alert>
                        )}
                    </div>
                )}
            </FormSection>
            );
        // No FormSection wrapper: the PageBlock hosting this already carries the
        // "Details" title, and nesting the two rendered the word twice.
        case 'details':
            return (
                <FormRow
                    label="Label"
                    description="Optional. Shown in the list and searchable — the only text field this list can filter on."
                >
                    <Input
                        placeholder="e.g. Overnight close"
                        value={form.label}
                        onChange={event => setForm(f => ({ ...f, label: event.target.value }))}
                    />
                </FormRow>
            );
        case 'preview':
            return (
            <div className="bg-muted/40 rounded-md border">
                <div className="border-b px-3 py-2 text-sm font-medium">What will happen</div>
                <div className="p-3">
                    {previewError ? (
                        <div className="text-destructive text-sm">
                            {previewError instanceof Error
                                ? previewError.message
                                : 'This schedule is not valid'}
                        </div>
                    ) : occurrences.length ? (
                        <ul className="flex flex-col gap-1.5">
                            {occurrences.map(occurrence => (
                                <li
                                    key={`${occurrence.dueAt}-${occurrence.action}`}
                                    className="flex items-center gap-2 text-sm"
                                >
                                    <Badge
                                        variant={
                                            occurrence.action === 'DISABLE'
                                                ? 'destructive'
                                                : 'success'
                                        }
                                    >
                                        {describeAction(occurrence.action)}
                                    </Badge>
                                    <span>{formatInstant(occurrence.dueAt)}</span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="text-muted-foreground text-sm">
                            {noPatternChosen
                                ? 'Turn on at least one of the schedules above.'
                                : 'Pick a target and a time to see the next occurrences.'}
                        </div>
                    )}
                </div>
            </div>
            );
    }
}


/**
 * A titled group of fields, matching the rhythm of the dashboard's own detail
 * pages: heading, one line of guidance, then the controls.
 */
function FormSection({
    title,
    description,
    children,
}: Readonly<{ title: string; description?: string; children: React.ReactNode }>) {
    return (
        <section className="space-y-4">
            <div>
                <h3 className="text-sm font-medium">{title}</h3>
                {description && <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>}
            </div>
            {children}
        </section>
    );
}

/**
 * Label above, control, description below -- the layout the dashboard's form
 * engine produces for a FormField, so this hand-built form lines up with
 * generated ones.
 */
function FormRow({
    label,
    description,
    children,
}: Readonly<{ label: string; description?: string; children: React.ReactNode }>) {
    return (
        <div className="grid gap-2">
            <Label>{label}</Label>
            {children}
            {description && <p className="text-muted-foreground text-xs">{description}</p>}
        </div>
    );
}

/**
 * Single-select over the brands (Sellers) this admin can see.
 *
 * A brand, not a set of channels: the rule states which business the report is
 * for, and the member cities are resolved at send time. That is what lets a city
 * added to the brand next month appear in reports written today.
 *
 * The resolved cities are listed beneath the choice, read-only. Without them the
 * picker hides exactly the fact an admin needs when a total looks wrong -- which
 * markets this report actually covered.
 */
function ReportBrandPicker({
    selected,
    onChange,
}: Readonly<{ selected: string | null; onChange: (id: string | null) => void }>) {
    const { data, isFetching } = useQuery({
        queryKey: ['report-brands'],
        queryFn: () => api.query(getReportBrandsDocument, {}),
    });

    // Grouped from channels rather than read from a sellers query: a brand with
    // no channels has nothing to report on, so it should not be offerable.
    const brands = new Map<string, { name: string; channels: string[] }>();
    for (const channel of ((data as any)?.channels?.items ?? []) as any[]) {
        // The default channel aggregates every other channel's catalogue, so
        // counting it would double every order in the report.
        //
        // Literal rather than DEFAULT_CHANNEL_CODE from @vendure/common: that is
        // the CJS lib/ build, no other dashboard file pulls it into the browser
        // bundle, and the picker this replaced used the literal for that reason.
        if (channel.code === '__default_channel__' || !channel.seller) {
            continue;
        }
        const id = String(channel.seller.id);
        const brand = brands.get(id) ?? { name: channel.seller.name, channels: [] };
        brand.channels.push(formatChannelCode(channel.code));
        brands.set(id, brand);
    }

    if (isFetching && !brands.size) {
        return <p className="text-muted-foreground text-xs">Loading brands…</p>;
    }
    if (!brands.size) {
        return <p className="text-muted-foreground text-xs">No brands available.</p>;
    }

    const chosen = selected ? brands.get(selected) : undefined;

    return (
        <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
                {[...brands.entries()].map(([id, brand]) => (
                    <Button
                        key={id}
                        type="button"
                        size="sm"
                        variant={selected === id ? 'default' : 'outline'}
                        aria-pressed={selected === id}
                        onClick={() => onChange(selected === id ? null : id)}
                    >
                        {brand.name}
                    </Button>
                ))}
            </div>
            <p className="text-muted-foreground text-xs">
                {chosen
                    ? `${chosen.channels.length} channel${
                          chosen.channels.length === 1 ? '' : 's'
                      }: ${chosen.channels.join(', ')}`
                    : 'Pick a brand'}
            </p>
        </div>
    );
}

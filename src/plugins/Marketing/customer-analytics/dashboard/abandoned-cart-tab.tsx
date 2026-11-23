import { api, AssetPickerDialog, Badge, Button, Card, CardContent, Input, Switch, toast, usePermissions } from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';
import { abandonedCartAnalyticsDocument, abandonedCartSettingsDocument, setAbandonedCartSettingsDocument } from './queries';

interface BodyVar { kind: string; value: string }
interface Stage { delayValue: number; delayUnit: string; templateName: string; language: string; headerImageUrl?: string; buttonUrlParam?: string; bodyVars: BodyVar[] }
interface Settings { enabled: boolean; minOrderValueMinor: number | null; costPerMessageMinor: number; stages: Stage[] }
interface PickedAsset { preview: string; source: string }

const STAGE_LABELS = ['Stage 1', 'Stage 2', 'Stage 3'];
const STAGE_HINTS = ['First nudge', 'Reminder', 'Last call'];

export function AbandonedCartTab() {
    const queryClient = useQueryClient();
    const { hasPermissions } = usePermissions();
    const canEdit = hasPermissions(['UpdateAbandonedCart', 'SuperAdmin']);
    const [draft, setDraft] = useState<Settings | null>(null);

    const settingsQuery = useQuery({
        queryKey: ['abandoned-cart-settings'],
        queryFn: () => api.query(abandonedCartSettingsDocument),
    });

    const analyticsQuery = useQuery({
        queryKey: ['abandoned-cart-analytics'],
        queryFn: () => api.query(abandonedCartAnalyticsDocument),
    });

    useEffect(() => {
        if (settingsQuery.data?.abandonedCartSettings) {
            setDraft(settingsQuery.data.abandonedCartSettings as Settings);
        }
    }, [settingsQuery.data]);

    const save = useMutation({
        mutationFn: (input: Settings) => api.mutate(setAbandonedCartSettingsDocument, { input }),
        onSuccess: () => {
            toast.success('Abandoned-cart settings saved');
            queryClient.invalidateQueries({ queryKey: ['abandoned-cart-settings'] });
        },
        onError: (e: any) => toast.error(e?.message ?? 'Save failed'),
    });

    if (settingsQuery.isLoading) {
        return <div className="p-4 text-muted-foreground">Loading…</div>;
    }
    if (settingsQuery.isError) {
        return (
            <div className="p-4 text-destructive">
                Failed to load abandoned-cart settings: {(settingsQuery.error as any)?.message ?? 'unknown error'}.
                <div className="mt-1 text-sm text-muted-foreground">
                    If this says a field is unknown, restart the server and re-run codegen. If it says Forbidden,
                    sign in as SuperAdmin or grant the ReadAbandonedCart permission.
                </div>
            </div>
        );
    }
    if (!draft) {
        return <div className="p-4 text-muted-foreground">No settings available.</div>;
    }

    const eligible = ((settingsQuery.data as any)?.abandonedCartEligiblePreview as number) ?? 0;
    // Dirty check: Save is only active when the working draft differs from the saved settings.
    const isDirty = JSON.stringify(draft) !== JSON.stringify((settingsQuery.data as any)?.abandonedCartSettings);
    const updateStage = (i: number, patch: Partial<Stage>) =>
        setDraft({ ...draft, stages: draft.stages.map((s, idx) => (idx === i ? { ...s, ...patch } : s)) });

    return (
        <div>
            {/* Top action bar */}
            {canEdit && (
                <div className="mb-4 flex items-center justify-end gap-3">
                    <span className="text-xs text-muted-foreground">
                        {save.isPending ? 'Saving changes…' : isDirty ? 'Unsaved changes' : 'No changes'}
                    </span>
                    <Button onClick={() => save.mutate(draft)} disabled={save.isPending || !isDirty}>
                        {save.isPending ? 'Saving…' : 'Save'}
                    </Button>
                </div>
            )}

            {/* Global settings header */}
            <Card className="mb-4">
                <CardContent className="flex flex-wrap items-end justify-between gap-4 pt-6">
                    <div className="flex items-end gap-6">
                        <div>
                            <label className="text-xs text-muted-foreground">Min order value (₹)</label>
                            <Input
                                type="number"
                                className="w-32"
                                value={draft.minOrderValueMinor == null ? '' : draft.minOrderValueMinor / 100}
                                placeholder="empty = no sends"
                                disabled={!canEdit}
                                onChange={e => setDraft({ ...draft, minOrderValueMinor: e.target.value === '' ? null : Math.round(Number(e.target.value) * 100) })}
                            />
                        </div>
                        <div>
                            <label className="text-xs text-muted-foreground" title="What you pay MSG91 per WhatsApp send — drives Message cost and ROI">
                                Cost / message (₹)
                            </label>
                            <Input
                                type="number"
                                className="w-32"
                                value={draft.costPerMessageMinor / 100}
                                disabled={!canEdit}
                                onChange={e => setDraft({ ...draft, costPerMessageMinor: Math.round(Number(e.target.value) * 100) })}
                            />
                        </div>
                    </div>
                    <div className="flex items-center gap-4">
                        <Badge variant="secondary" className="text-sm">Eligible now: {eligible}</Badge>
                        <div className="flex items-center gap-2">
                            <Switch
                                checked={draft.enabled}
                                disabled={!canEdit}
                                onCheckedChange={value => setDraft({ ...draft, enabled: value })}
                            />
                            <span className="text-sm font-medium">{draft.enabled ? 'Enabled' : 'Disabled'}</span>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Analytics */}
            <AnalyticsSummary data={(analyticsQuery.data as any)?.abandonedCartAnalytics} />

            {/* Stages */}
            <div className="space-y-4">
                {draft.stages.map((stage, i) => (
                    <Card key={i} className="overflow-hidden">
                        <div className="flex items-center gap-2 border-b bg-muted/40 px-6 py-3">
                            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                                {i + 1}
                            </span>
                            <span className="font-medium">{STAGE_LABELS[i]}</span>
                            <span className="text-xs text-muted-foreground">· {STAGE_HINTS[i]}</span>
                        </div>
                        <CardContent className="space-y-5 pt-5">
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">Delay</label>
                                    <div className="flex gap-2">
                                        <Input type="number" value={stage.delayValue} disabled={!canEdit}
                                            onChange={e => updateStage(i, { delayValue: Number(e.target.value) })} />
                                        <select className="rounded-md border bg-background px-2 text-sm" value={stage.delayUnit} disabled={!canEdit}
                                            onChange={e => updateStage(i, { delayUnit: e.target.value })}>
                                            <option value="seconds">seconds</option>
                                            <option value="hours">hours</option>
                                            <option value="days">days</option>
                                        </select>
                                    </div>
                                </div>
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">Template name</label>
                                    <Input value={stage.templateName} disabled={!canEdit}
                                        onChange={e => updateStage(i, { templateName: e.target.value })} />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-xs text-muted-foreground">Language</label>
                                    <Input value={stage.language} disabled={!canEdit}
                                        onChange={e => updateStage(i, { language: e.target.value })} />
                                </div>
                            </div>

                            <StageImagePicker
                                url={stage.headerImageUrl}
                                disabled={!canEdit}
                                onChange={url => updateStage(i, { headerImageUrl: url })}
                            />

                            <div className="space-y-1">
                                <label className="text-xs text-muted-foreground">Button URL value (optional)</label>
                                <Input value={stage.buttonUrlParam ?? ''} disabled={!canEdit}
                                    onChange={e => updateStage(i, { buttonUrlParam: e.target.value })}
                                    placeholder="dynamic URL suffix for the template's button" />
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    );
}

interface StageCount { stage: number; count: number }
interface Analytics {
    totalSent: number;
    sentByStage: StageCount[];
    conversions: number;
    conversionsByStage: StageCount[];
    conversionRate: number;
    avgTimeToOrderSeconds: number;
    revenueRecoveredMinor: number;
    totalCostMinor: number;
    roi: number;
}

function formatDuration(seconds: number): string {
    if (!seconds) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${Math.round(seconds)}s`;
}

function AnalyticsSummary(props: { data?: Analytics }) {
    const a = props.data;
    if (!a) return null;
    const countFor = (list: StageCount[], stage: number) => list.find(s => s.stage === stage)?.count ?? 0;
    const rupees = (minor: number) => `₹${Math.round(minor / 100).toLocaleString('en-IN')}`;
    const cards = [
        { label: 'Messages sent', value: String(a.totalSent) },
        { label: 'Conversions', value: String(a.conversions) },
        { label: 'Conversion rate', value: `${Math.round(a.conversionRate * 100)}%` },
        { label: 'Avg. cart → order', value: formatDuration(a.avgTimeToOrderSeconds) },
        { label: 'Revenue recovered', value: rupees(a.revenueRecoveredMinor) },
        { label: 'Message cost', value: rupees(a.totalCostMinor) },
        { label: 'ROI', value: a.totalCostMinor === 0 ? '—' : `${a.roi.toFixed(1)}×` },
    ];
    return (
        <Card className="mb-4">
            <CardContent className="space-y-4 pt-5">
                <div className="font-medium">Analytics</div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {cards.map(c => (
                        <div key={c.label} className="rounded-md border p-3">
                            <div className="text-xs text-muted-foreground">{c.label}</div>
                            <div className="text-2xl font-semibold">{c.value}</div>
                        </div>
                    ))}
                </div>
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-muted-foreground">
                            <th className="py-1 font-normal">Stage</th>
                            <th className="py-1 font-normal">Sent</th>
                            <th className="py-1 font-normal">Ordered at</th>
                        </tr>
                    </thead>
                    <tbody>
                        {[1, 2, 3].map(stage => (
                            <tr key={stage} className="border-t">
                                <td className="py-1">Stage {stage}</td>
                                <td className="py-1">{countFor(a.sentByStage, stage)}</td>
                                <td className="py-1">{countFor(a.conversionsByStage, stage)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </CardContent>
        </Card>
    );
}

/**
 * The admin asset pipeline force-appends `?preset=thumb` (a 150x150 CROP) to
 * asset URLs so grids load fast. For a wide banner that crop shows only a centre
 * slice. Strip the preset so we store + display the full-size preview (native
 * 1080x607). The WhatsApp send strips it too (defence in depth) — see
 * abandoned-cart/functions/build-components.ts toFullSizeImageUrl.
 */
function stripPreset(url?: string): string | undefined {
    if (!url) return url;
    let out = url.replace(/([?&])preset=[^&#]*/gi, '$1');
    out = out.replace(/[?&]$/, '').replace(/\?&/, '?').replace(/&&+/g, '&');
    return out;
}

function StageImagePicker(props: { url?: string; disabled: boolean; onChange: (url?: string) => void }) {
    const { url, disabled, onChange } = props;
    const [open, setOpen] = useState(false);
    const handleSelect = (assets: PickedAsset[]) => {
        const picked = assets[0];
        if (picked) {
            onChange(stripPreset(picked.preview));
        }
    };
    return (
        <div className="space-y-2">
            <label className="text-xs text-muted-foreground">
                Header image — only if the template has a dynamic image header
            </label>
            <div className="flex items-start gap-4">
                {url ? (
                    <img
                        src={stripPreset(url)}
                        alt="Header"
                        // Box locked to the banner's exact 1080:607 ratio, so the
                        // full image fills it with no crop and no letterbox.
                        className="aspect-[1080/607] w-64 rounded-md border bg-muted object-cover"
                    />
                ) : (
                    <div className="flex aspect-[1080/607] w-64 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
                        No image
                    </div>
                )}
                {!disabled && (
                    <div className="flex flex-col gap-2">
                        <Button variant="secondary" type="button" onClick={() => setOpen(true)}>
                            {url ? 'Change image' : 'Choose image'}
                        </Button>
                        {url && (
                            <Button variant="ghost" type="button" onClick={() => onChange(undefined)}>
                                Remove
                            </Button>
                        )}
                        {url && <span className="max-w-xs break-all text-[10px] text-muted-foreground">{url}</span>}
                    </div>
                )}
            </div>
            {open && (
                <AssetPickerDialog
                    open={open}
                    onClose={() => setOpen(false)}
                    onSelect={handleSelect}
                />
            )}
        </div>
    );
}

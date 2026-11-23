import {
    api,
    Badge,
    Button,
    Card,
    CardContent,
    Input,
    Page,
    PageTitle,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Spinner,
    toast,
    usePermissions,
} from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import React, { useState } from 'react';
import { AbandonedCartTab } from './abandoned-cart-tab';
import {
    customerSegmentExportDocument,
    customerSegmentListDocument,
    customerSegmentSummaryDocument,
    saveCustomerSegmentAsGroupDocument,
    setRecencyThresholdsDocument,
} from './queries';
import {
    buildCsv,
    EXPORT_ROW_CAP,
    formatDate,
    formatDaysAgo,
    SegmentState,
    validateThresholds,
} from './customer-analytics.helpers';

const SEGMENTS: Array<{ key: SegmentState; label: string; tone: string }> = [
    { key: 'ACTIVE', label: 'Active', tone: 'text-green-600' },
    { key: 'AT_RISK', label: 'At-Risk', tone: 'text-amber-600' },
    { key: 'CHURN', label: 'Churn', tone: 'text-red-600' },
    { key: 'NEVER', label: 'Never ordered', tone: 'text-muted-foreground' },
];

// State -> Badge variant. Text + color (never color alone) keeps it colorblind-safe.
const BADGE_VARIANT: Record<SegmentState, 'success' | 'warning' | 'destructive' | 'secondary'> = {
    ACTIVE: 'success',
    AT_RISK: 'warning',
    CHURN: 'destructive',
    NEVER: 'secondary',
};

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

function downloadCsv(filename: string, csv: string): void {
    // Leading BOM so Excel reads UTF-8 (₹, accented names) correctly.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

export function CustomerAnalyticsPage() {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const { hasPermissions } = usePermissions();
    // SuperAdmin OR fallback mirrors the resolver's @Allow so the owner can edit before
    // the custom Update permission is assigned to a role.
    const canEditThresholds = hasPermissions(['UpdateCustomerAnalytics', 'SuperAdmin']);
    // CSV export ships customer PII (emails + phones); gated above the view-only Read role,
    // matching the customerSegmentExport @Allow on the resolver. Read-only sees no button.
    const canExport = hasPermissions(['UpdateCustomerAnalytics', 'SuperAdmin']);
    const [activeTab, setActiveTab] = useState<'segments' | 'abandoned'>('segments');
    const [segment, setSegment] = useState<SegmentState>('AT_RISK');
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
    const [editingThresholds, setEditingThresholds] = useState(false);
    const [activeInput, setActiveInput] = useState('');
    const [atRiskInput, setAtRiskInput] = useState('');

    const summaryQuery = useQuery({
        queryKey: ['customer-segment-summary'],
        queryFn: () => api.query(customerSegmentSummaryDocument),
    });
    const listQuery = useQuery({
        queryKey: ['customer-segment-list', segment, page, pageSize],
        queryFn: () =>
            api.query(customerSegmentListDocument, {
                state: segment,
                options: { skip: (page - 1) * pageSize, take: pageSize },
            }),
    });

    const saveMutation = useMutation({
        mutationFn: () => api.mutate(saveCustomerSegmentAsGroupDocument, { state: segment, groupName: null }),
        onSuccess: (result: any) => {
            const name = result?.saveCustomerSegmentAsGroup?.name ?? 'group';
            toast.success(`${isSynced ? 'Synced' : 'Saved'} segment to customer group "${name}"`);
            queryClient.invalidateQueries({ queryKey: ['customer-segment-summary'] });
        },
        onError: (error: any) => toast.error(`Save failed: ${error.message}`),
    });

    const exportMutation = useMutation({
        mutationFn: () => api.query(customerSegmentExportDocument, { state: segment }),
        onSuccess: (result: any) => {
            const rows: any[] = result?.customerSegmentExport ?? [];
            if (rows.length === 0) {
                toast.error('No customers to export in this segment.');
                return;
            }
            const label = SEGMENTS.find(s => s.key === segment)?.label ?? segment;
            const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const stamp = new Date().toISOString().slice(0, 10);
            downloadCsv(`customer-analytics-${safeLabel}-${stamp}.csv`, buildCsv(rows));
            const capped = rows.length >= EXPORT_ROW_CAP;
            const note = capped ? ` (capped at ${EXPORT_ROW_CAP.toLocaleString()} — segment is larger)` : '';
            toast.success(`Exported ${rows.length.toLocaleString()} customers to CSV${note}`);
        },
        onError: (error: any) => toast.error(`Export failed: ${error.message}`),
    });

    const summary = (summaryQuery.data as any)?.customerSegmentSummary;
    const counts: Record<SegmentState, number> = {
        ACTIVE: summary?.active ?? 0,
        AT_RISK: summary?.atRisk ?? 0,
        CHURN: summary?.churn ?? 0,
        NEVER: summary?.never ?? 0,
    };
    const list = (listQuery.data as any)?.customerSegmentList;
    const items: any[] = list?.items ?? [];
    const totalItems: number = list?.totalItems ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const config = summary?.config;
    // Group already exists for this segment → second save is a Sync, not a fresh Save.
    const savedStates: SegmentState[] = summary?.savedStates ?? [];
    const isSynced = savedStates.includes(segment);

    const selectSegment = (next: SegmentState) => {
        setSegment(next);
        setPage(1);
    };

    const changePageSize = (next: number) => {
        setPageSize(next);
        setPage(1);
    };

    const beginEditThresholds = () => {
        setActiveInput(String(config?.activeWithinDays ?? ''));
        setAtRiskInput(String(config?.atRiskUntilDays ?? ''));
        setEditingThresholds(true);
    };

    const activeNum = Number(activeInput);
    const atRiskNum = Number(atRiskInput);
    const inputsFilled = activeInput.trim() !== '' && atRiskInput.trim() !== '';
    const thresholdError = inputsFilled
        ? validateThresholds(activeNum, atRiskNum)
        : 'Enter both thresholds.';

    const thresholdsMutation = useMutation({
        mutationFn: () =>
            api.mutate(setRecencyThresholdsDocument, {
                activeWithinDays: activeNum,
                atRiskUntilDays: atRiskNum,
            }),
        onSuccess: () => {
            toast.success('Recency thresholds updated');
            setEditingThresholds(false);
            // Counts AND list rows reclassify against the new thresholds — invalidate both.
            queryClient.invalidateQueries({ queryKey: ['customer-segment-summary'] });
            queryClient.invalidateQueries({ queryKey: ['customer-segment-list'] });
        },
        onError: (error: any) => toast.error(`Update failed: ${error.message}`),
    });

    return (
        <Page pageId="customer-analytics-list">
            <PageTitle>Customer Analytics</PageTitle>
            <div className="mb-4 flex gap-2 px-4 pt-4">
                <Button variant={activeTab === 'segments' ? 'default' : 'secondary'} onClick={() => setActiveTab('segments')}>
                    Segments
                </Button>
                <Button variant={activeTab === 'abandoned' ? 'default' : 'secondary'} onClick={() => setActiveTab('abandoned')}>
                    Abandoned Cart
                </Button>
            </div>
            {activeTab === 'abandoned' ? (
                <div className="px-4 pb-6">
                    <AbandonedCartTab />
                </div>
            ) : (
            <div className="space-y-6 px-4 pb-6">
                {config ? (
                    <div className="space-y-2">
                        <div className="flex items-center justify-between gap-3">
                            <p className="text-muted-foreground text-sm">
                                Recency view — Active ≤ {config.activeWithinDays}d, At-Risk ≤{' '}
                                {config.atRiskUntilDays}d, Churn beyond. Scoped to the current channel.
                            </p>
                            {canEditThresholds && !editingThresholds ? (
                                <Button variant="outline" size="sm" onClick={beginEditThresholds}>
                                    Edit thresholds
                                </Button>
                            ) : null}
                        </div>
                        {editingThresholds ? (
                            <Card>
                                <CardContent className="space-y-3 py-4">
                                    <div className="flex flex-wrap items-end gap-4">
                                        <label className="space-y-1 text-sm">
                                            <span className="text-muted-foreground block text-xs font-medium uppercase tracking-wide">
                                                Active within (days)
                                            </span>
                                            <Input
                                                type="number"
                                                min={0}
                                                className="w-32"
                                                value={activeInput}
                                                onChange={e => setActiveInput(e.target.value)}
                                            />
                                        </label>
                                        <label className="space-y-1 text-sm">
                                            <span className="text-muted-foreground block text-xs font-medium uppercase tracking-wide">
                                                At-Risk until (days)
                                            </span>
                                            <Input
                                                type="number"
                                                min={0}
                                                className="w-32"
                                                value={atRiskInput}
                                                onChange={e => setAtRiskInput(e.target.value)}
                                            />
                                        </label>
                                        <div className="flex gap-2">
                                            <Button
                                                onClick={() => thresholdsMutation.mutate()}
                                                disabled={thresholdsMutation.isPending || thresholdError !== null}
                                            >
                                                {thresholdsMutation.isPending ? 'Saving…' : 'Save'}
                                            </Button>
                                            <Button
                                                variant="outline"
                                                onClick={() => setEditingThresholds(false)}
                                                disabled={thresholdsMutation.isPending}
                                            >
                                                Cancel
                                            </Button>
                                        </div>
                                    </div>
                                    {thresholdError && inputsFilled ? (
                                        <p className="text-destructive text-sm">{thresholdError}</p>
                                    ) : null}
                                </CardContent>
                            </Card>
                        ) : null}
                    </div>
                ) : null}
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    {SEGMENTS.map(s => (
                        <button key={s.key} onClick={() => selectSegment(s.key)} className="text-left">
                            <Card className={segment === s.key ? 'border-primary ring-primary ring-1' : ''}>
                                <CardContent className="py-4">
                                    <div className={`text-2xl font-bold ${s.tone}`}>
                                        {summaryQuery.isLoading ? '…' : counts[s.key].toLocaleString()}
                                    </div>
                                    <div className="text-muted-foreground mt-1 text-xs font-medium uppercase tracking-wide">
                                        {s.label}
                                    </div>
                                </CardContent>
                            </Card>
                        </button>
                    ))}
                </div>
                <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">
                        {SEGMENTS.find(s => s.key === segment)?.label} · {totalItems.toLocaleString()} customers
                    </div>
                    <div className="flex gap-2">
                        {canExport && (
                            <Button
                                variant="outline"
                                onClick={() => exportMutation.mutate()}
                                disabled={exportMutation.isPending || totalItems === 0}
                            >
                                {exportMutation.isPending ? 'Exporting…' : 'Download CSV'}
                            </Button>
                        )}
                        <Button
                            onClick={() => saveMutation.mutate()}
                            disabled={saveMutation.isPending || totalItems === 0}
                        >
                            {saveMutation.isPending
                                ? isSynced
                                    ? 'Syncing…'
                                    : 'Saving…'
                                : isSynced
                                  ? 'Sync group'
                                  : 'Save as group'}
                        </Button>
                    </div>
                </div>
                <Card>
                    <CardContent className="p-0">
                        {listQuery.isLoading ? (
                            <div className="flex justify-center p-8">
                                <Spinner />
                            </div>
                        ) : items.length === 0 ? (
                            <div className="text-muted-foreground p-8 text-center text-sm">
                                {segment === 'AT_RISK'
                                    ? 'No at-risk customers — retention looks healthy.'
                                    : `No customers in the ${SEGMENTS.find(s => s.key === segment)?.label} segment.`}
                            </div>
                        ) : (
                            <table className="w-full text-sm">
                                <thead className="text-muted-foreground border-b text-left text-xs uppercase">
                                    <tr>
                                        <th className="px-4 py-2">Customer</th>
                                        <th className="px-4 py-2">Email</th>
                                        <th className="px-4 py-2">Last order</th>
                                        <th className="px-4 py-2">Days ago</th>
                                        <th className="px-4 py-2">State</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {items.map(row => (
                                        <tr
                                            key={String(row.customerId)}
                                            onClick={() =>
                                                navigate({
                                                    to: '/customers/$id',
                                                    params: { id: String(row.customerId) },
                                                })
                                            }
                                            className="hover:bg-muted/50 cursor-pointer border-b last:border-0"
                                        >
                                            <td className="text-primary px-4 py-2 hover:underline">
                                                {row.firstName} {row.lastName}
                                            </td>
                                            <td className="text-muted-foreground px-4 py-2">{row.emailAddress}</td>
                                            <td className="px-4 py-2">{formatDate(row.lastOrderAt)}</td>
                                            <td className="px-4 py-2">{formatDaysAgo(row.daysSinceLastOrder)}</td>
                                            <td className="px-4 py-2">
                                                <Badge variant={BADGE_VARIANT[row.state as SegmentState]}>
                                                    {SEGMENTS.find(s => s.key === row.state)?.label}
                                                </Badge>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </CardContent>
                </Card>
                <div className="flex items-center justify-end px-2">
                    <div className="flex items-center space-x-6 lg:space-x-8">
                        <div className="flex items-center space-x-2">
                            <p className="text-sm font-medium">Rows per page</p>
                            <Select
                                value={`${pageSize}`}
                                onValueChange={value => changePageSize(Number(value))}
                            >
                                <SelectTrigger className="h-8 w-[70px]">
                                    <SelectValue placeholder={pageSize} />
                                </SelectTrigger>
                                <SelectContent side="top">
                                    {PAGE_SIZE_OPTIONS.map(size => (
                                        <SelectItem key={size} value={`${size}`}>
                                            {size}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex items-center justify-center text-sm font-medium">
                            <span className="w-[100px] text-center">
                                Page {page} of {totalPages}
                            </span>
                        </div>
                        <div className="flex items-center space-x-2">
                            <Button
                                variant="outline"
                                type="button"
                                className="hidden h-8 w-8 p-0 lg:flex"
                                onClick={() => setPage(1)}
                                disabled={page <= 1}
                            >
                                <span className="sr-only">Go to first page</span>
                                <ChevronsLeft />
                            </Button>
                            <Button
                                variant="outline"
                                type="button"
                                className="h-8 w-8 p-0"
                                onClick={() => setPage(p => p - 1)}
                                disabled={page <= 1}
                            >
                                <span className="sr-only">Go to previous page</span>
                                <ChevronLeft />
                            </Button>
                            <Button
                                variant="outline"
                                type="button"
                                className="h-8 w-8 p-0"
                                onClick={() => setPage(p => p + 1)}
                                disabled={page >= totalPages}
                            >
                                <span className="sr-only">Go to next page</span>
                                <ChevronRight />
                            </Button>
                            <Button
                                variant="outline"
                                type="button"
                                className="hidden h-8 w-8 p-0 lg:flex"
                                onClick={() => setPage(totalPages)}
                                disabled={page >= totalPages}
                            >
                                <span className="sr-only">Go to last page</span>
                                <ChevronsRight />
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
            )}
        </Page>
    );
}

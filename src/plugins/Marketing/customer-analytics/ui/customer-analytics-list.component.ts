import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { DataService, NotificationService, PermissionsService, SharedModule } from '@vendure/admin-ui/core';
import gql from 'graphql-tag';
import { BehaviorSubject, Observable, combineLatest, of } from 'rxjs';
import { catchError, startWith, switchMap, tap } from 'rxjs/operators';
import {
    buildCsv,
    CsvExportRow,
    EXPORT_ROW_CAP,
    formatDate as formatDateValue,
    formatDaysAgo as formatDaysAgoValue,
    SegmentState,
    validateThresholds,
} from './customer-analytics.helpers';

// ---------------------------------------------------------------------------
// GraphQL documents — rewritten as raw gql for the Angular DataService. The
// React dashboard's graphql() typed documents are NOT reusable across the build
// boundary, so these are hand-authored to the same admin API contract.
// ---------------------------------------------------------------------------
const CUSTOMER_SEGMENT_SUMMARY = gql`
    query CustomerSegmentSummary {
        customerSegmentSummary {
            active
            atRisk
            churn
            never
            savedStates
            config {
                activeWithinDays
                atRiskUntilDays
            }
        }
    }
`;

const CUSTOMER_SEGMENT_LIST = gql`
    query CustomerSegmentList($state: CustomerSegmentState!, $options: CustomerSegmentListOptions) {
        customerSegmentList(state: $state, options: $options) {
            totalItems
            items {
                customerId
                firstName
                lastName
                emailAddress
                lastOrderAt
                daysSinceLastOrder
                state
            }
        }
    }
`;

const CUSTOMER_SEGMENT_EXPORT = gql`
    query CustomerSegmentExport($state: CustomerSegmentState!) {
        customerSegmentExport(state: $state) {
            customerId
            firstName
            lastName
            emailAddress
            phoneNumber
            orderCount
            totalOrderValue
            lastOrderAt
            state
        }
    }
`;

const SAVE_CUSTOMER_SEGMENT_AS_GROUP = gql`
    mutation SaveCustomerSegmentAsGroup($state: CustomerSegmentState!, $groupName: String) {
        saveCustomerSegmentAsGroup(state: $state, groupName: $groupName) {
            id
            name
        }
    }
`;

const SET_RECENCY_THRESHOLDS = gql`
    mutation SetRecencyThresholds($activeWithinDays: Int!, $atRiskUntilDays: Int!) {
        setRecencyThresholds(activeWithinDays: $activeWithinDays, atRiskUntilDays: $atRiskUntilDays) {
            activeWithinDays
            atRiskUntilDays
        }
    }
`;

const GET_ABANDONED_CART_SETTINGS = gql`
    query AbandonedCartSettings {
        abandonedCartSettings {
            enabled minOrderValueMinor
            stages { delayValue delayUnit templateName language headerImageUrl buttonUrlParam bodyVars { kind value } }
        }
        abandonedCartEligiblePreview
    }
`;

const SET_ABANDONED_CART_SETTINGS = gql`
    mutation SetAbandonedCartSettings($input: AbandonedCartSettingsInput!) {
        setAbandonedCartSettings(input: $input) {
            enabled minOrderValueMinor
            stages { delayValue delayUnit templateName language headerImageUrl buttonUrlParam bodyVars { kind value } }
        }
    }
`;

interface SegmentMeta {
    key: SegmentState;
    label: string;
    toneClass: string;
}

const SEGMENTS: readonly SegmentMeta[] = [
    { key: 'ACTIVE', label: 'Active', toneClass: 'tone-active' },
    { key: 'AT_RISK', label: 'At-Risk', toneClass: 'tone-at-risk' },
    { key: 'CHURN', label: 'Churn', toneClass: 'tone-churn' },
    { key: 'NEVER', label: 'Never ordered', toneClass: 'tone-never' },
];

// State -> badge variant class. Text + colour (never colour alone) keeps it colourblind-safe.
const BADGE_VARIANT: Record<SegmentState, string> = {
    ACTIVE: 'badge-success',
    AT_RISK: 'badge-warning',
    CHURN: 'badge-destructive',
    NEVER: 'badge-secondary',
};

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_OPTIONS: readonly number[] = [10, 25, 50, 100];

interface SegmentConfig {
    activeWithinDays: number;
    atRiskUntilDays: number;
}

interface SegmentSummary {
    active: number;
    atRisk: number;
    churn: number;
    never: number;
    savedStates: SegmentState[];
    config: SegmentConfig | null;
}

interface SegmentRow {
    customerId: string;
    firstName: string;
    lastName: string;
    emailAddress: string;
    lastOrderAt: string | null;
    daysSinceLastOrder: number | null;
    state: SegmentState;
}

interface SummaryView {
    loading: boolean;
    summary: SegmentSummary | null;
}

interface ListView {
    loading: boolean;
    items: SegmentRow[];
    totalItems: number;
}

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

@Component({
    selector: 'customer-analytics-list',
    templateUrl: './customer-analytics-list.component.html',
    styleUrls: ['./customer-analytics-list.component.scss'],
    standalone: true,
    imports: [SharedModule],
    changeDetection: ChangeDetectionStrategy.Default,
})
export class CustomerAnalyticsListComponent implements OnInit {
    readonly segments = SEGMENTS;
    readonly pageSizeOptions = PAGE_SIZE_OPTIONS;
    readonly badgeVariant = BADGE_VARIANT;

    // SuperAdmin OR fallback mirrors the resolver's @Allow so the owner can edit before
    // the custom Update permission is assigned to a role (userHasPermissions = OR).
    canEditThresholds = false;
    // CSV export ships customer PII (emails + phones); gated above the view-only Read role,
    // mirroring the customerSegmentExport @Allow. Read-only roles see no Download button.
    canExport = false;
    // Gates all abandoned-cart form controls; mirrors the resolver's @Allow(UpdateAbandonedCart).
    canEditAbandoned = false;

    // Mirror fields for template binding + event handlers (avoid async pipe in handlers).
    segment: SegmentState = 'AT_RISK';
    page = 1;
    pageSize = DEFAULT_PAGE_SIZE;
    editingThresholds = false;
    activeInput = '';
    atRiskInput = '';
    exporting = false;
    saving = false;
    savingThresholds = false;

    activeTab: 'segments' | 'abandoned' = 'segments';
    abandonedSettings: { enabled: boolean; minOrderValueMinor: number | null; stages: any[] } | null = null;
    eligiblePreview = 0;

    summary$!: Observable<SummaryView>;
    list$!: Observable<ListView>;

    private readonly segment$ = new BehaviorSubject<SegmentState>('AT_RISK');
    private readonly page$ = new BehaviorSubject<number>(1);
    private readonly pageSize$ = new BehaviorSubject<number>(DEFAULT_PAGE_SIZE);
    // Pinged after threshold/save mutations to force a fresh summary + list fetch.
    private readonly refresh$ = new BehaviorSubject<void>(undefined);
    // Last summary snapshot, for Save-vs-Sync labelling and threshold prefill.
    private latestSummary: SegmentSummary | null = null;

    constructor(
        private readonly dataService: DataService,
        private readonly notificationService: NotificationService,
        private readonly permissionsService: PermissionsService,
        private readonly router: Router,
    ) {}

    ngOnInit(): void {
        this.canEditThresholds = this.permissionsService.userHasPermissions([
            'UpdateCustomerAnalytics',
            'SuperAdmin',
        ]);
        this.canExport = this.permissionsService.userHasPermissions([
            'UpdateCustomerAnalytics',
            'SuperAdmin',
        ]);
        this.canEditAbandoned = this.permissionsService.userHasPermissions([
            'UpdateAbandonedCart',
            'SuperAdmin',
        ]);
        // refetchOnChannelChange keeps the channel-scoped counts/list correct when the
        // admin switches the active channel; mapStream (not mapSingle) keeps the
        // subscription alive so that refetch actually re-renders. catchError mirrors the
        // React page's silent degrade (no toast) while keeping loading distinct from empty.
        this.summary$ = this.refresh$.pipe(
            switchMap(() =>
                this.dataService
                    .query<{ customerSegmentSummary: SegmentSummary }>(
                        CUSTOMER_SEGMENT_SUMMARY,
                        {},
                        'network-only',
                    )
                    .refetchOnChannelChange()
                    .mapStream(data => ({ loading: false, summary: data.customerSegmentSummary }))
                    .pipe(
                        startWith<SummaryView>({ loading: true, summary: null }),
                        catchError(() => of<SummaryView>({ loading: false, summary: null })),
                    ),
            ),
            // Capture the latest summary for Save-vs-Sync labelling and threshold prefill.
            // Done in-pipe (not a second subscribe) so the template's async pipe is the
            // single subscriber — no duplicate query, no leaked subscription.
            tap(view => {
                if (view.summary) {
                    this.latestSummary = view.summary;
                }
            }),
        );
        this.list$ = combineLatest([this.segment$, this.page$, this.pageSize$, this.refresh$]).pipe(
            switchMap(([state, page, pageSize]) =>
                this.dataService
                    .query<{ customerSegmentList: { items: SegmentRow[]; totalItems: number } }>(
                        CUSTOMER_SEGMENT_LIST,
                        { state, options: { skip: (page - 1) * pageSize, take: pageSize } },
                        'network-only',
                    )
                    .refetchOnChannelChange()
                    .mapStream(data => ({
                        loading: false,
                        items: data.customerSegmentList.items,
                        totalItems: data.customerSegmentList.totalItems,
                    }))
                    .pipe(
                        startWith<ListView>({ loading: true, items: [], totalItems: 0 }),
                        catchError(() => of<ListView>({ loading: false, items: [], totalItems: 0 })),
                    ),
            ),
        );
        this.loadAbandonedSettings();
    }

    segmentLabel(state: SegmentState): string {
        return SEGMENTS.find(s => s.key === state)?.label ?? state;
    }

    // Thin template-facing wrappers over the pure (unit-tested) helpers.
    formatDate(iso: string | null): string {
        return formatDateValue(iso);
    }

    formatDaysAgo(days: number | null): string {
        return formatDaysAgoValue(days);
    }

    totalPages(totalItems: number): number {
        return Math.max(1, Math.ceil(totalItems / this.pageSize));
    }

    counts(summary: SegmentSummary | null): Record<SegmentState, number> {
        return {
            ACTIVE: summary?.active ?? 0,
            AT_RISK: summary?.atRisk ?? 0,
            CHURN: summary?.churn ?? 0,
            NEVER: summary?.never ?? 0,
        };
    }

    isSynced(): boolean {
        return (this.latestSummary?.savedStates ?? []).includes(this.segment);
    }

    selectSegment(next: SegmentState): void {
        this.segment = next;
        this.page = 1;
        this.segment$.next(next);
        this.page$.next(1);
    }

    changePageSize(next: number | string): void {
        const value = Number(next);
        this.pageSize = value;
        this.page = 1;
        this.pageSize$.next(value);
        this.page$.next(1);
    }

    setPage(next: number): void {
        this.page = next;
        this.page$.next(next);
    }

    beginEditThresholds(): void {
        const config = this.latestSummary?.config;
        this.activeInput = config ? String(config.activeWithinDays) : '';
        this.atRiskInput = config ? String(config.atRiskUntilDays) : '';
        this.editingThresholds = true;
    }

    cancelEditThresholds(): void {
        this.editingThresholds = false;
    }

    get inputsFilled(): boolean {
        return this.activeInput.trim() !== '' && this.atRiskInput.trim() !== '';
    }

    get thresholdError(): string | null {
        if (!this.inputsFilled) {
            return 'Enter both thresholds.';
        }
        return validateThresholds(Number(this.activeInput), Number(this.atRiskInput));
    }

    saveThresholds(): void {
        if (this.thresholdError !== null) {
            return;
        }
        this.savingThresholds = true;
        this.dataService
            .mutate(SET_RECENCY_THRESHOLDS, {
                activeWithinDays: Number(this.activeInput),
                atRiskUntilDays: Number(this.atRiskInput),
            })
            .subscribe({
                next: () => {
                    this.savingThresholds = false;
                    this.editingThresholds = false;
                    this.notificationService.success('Recency thresholds updated');
                    // Counts AND list rows reclassify against the new thresholds — refetch both.
                    this.refresh$.next();
                },
                error: (err: Error) => {
                    this.savingThresholds = false;
                    this.notificationService.error(`Update failed: ${err.message}`);
                },
            });
    }

    saveAsGroup(): void {
        // Snapshot segment + sync state at fire-time: the refetch below would flip
        // isSynced, and a fast segment switch would mislabel the toast.
        const stateAtFire = this.segment;
        const wasSynced = this.isSynced();
        this.saving = true;
        this.dataService
            .mutate<{ saveCustomerSegmentAsGroup: { id: string; name: string } }>(
                SAVE_CUSTOMER_SEGMENT_AS_GROUP,
                { state: stateAtFire, groupName: null },
            )
            .subscribe({
                next: result => {
                    this.saving = false;
                    const name = result?.saveCustomerSegmentAsGroup?.name ?? 'group';
                    this.notificationService.success(
                        `${wasSynced ? 'Synced' : 'Saved'} segment to customer group "${name}"`,
                    );
                    this.refresh$.next();
                },
                error: (err: Error) => {
                    this.saving = false;
                    this.notificationService.error(`Save failed: ${err.message}`);
                },
            });
    }

    exportCsv(): void {
        // Snapshot segment + label at fire-time so a mid-request switch can't mislabel the file.
        const stateAtFire = this.segment;
        const label = this.segmentLabel(stateAtFire);
        this.exporting = true;
        this.dataService
            .query<{ customerSegmentExport: CsvExportRow[] }>(
                CUSTOMER_SEGMENT_EXPORT,
                { state: stateAtFire },
                'network-only',
            )
            .single$.subscribe({
                next: data => {
                    this.exporting = false;
                    const rows = data?.customerSegmentExport ?? [];
                    if (rows.length === 0) {
                        this.notificationService.error('No customers to export in this segment.');
                        return;
                    }
                    const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                    const stamp = new Date().toISOString().slice(0, 10);
                    downloadCsv(`customer-analytics-${safeLabel}-${stamp}.csv`, buildCsv(rows));
                    const capped = rows.length >= EXPORT_ROW_CAP;
                    const note = capped
                        ? ` (capped at ${EXPORT_ROW_CAP.toLocaleString()} — segment is larger)`
                        : '';
                    this.notificationService.success(
                        `Exported ${rows.length.toLocaleString()} customers to CSV${note}`,
                    );
                },
                error: (err: Error) => {
                    this.exporting = false;
                    this.notificationService.error(`Export failed: ${err.message}`);
                },
            });
    }

    goToCustomer(customerId: string): void {
        this.router.navigate(['/customer/customers', customerId]);
    }

    loadAbandonedSettings(): void {
        // TODO: settings are not refetched on channel switch — GET_ABANDONED_CART_SETTINGS is
        // channel-scoped, but wiring it to the same refetchOnChannelChange() stream as summary$
        // would require lifting it into a reactive pipeline; left as a follow-up.
        this.dataService.query(GET_ABANDONED_CART_SETTINGS).single$.subscribe({
            next: (data: any) => {
                this.abandonedSettings = JSON.parse(JSON.stringify(data.abandonedCartSettings));
                this.eligiblePreview = data.abandonedCartEligiblePreview;
            },
            error: () => this.notificationService.error('Could not load abandoned-cart settings'),
        });
    }

    saveAbandonedSettings(): void {
        this.dataService.mutate(SET_ABANDONED_CART_SETTINGS, { input: this.abandonedSettings }).subscribe({
            next: () => this.notificationService.success('Abandoned-cart settings saved'),
            error: (e: any) => this.notificationService.error(e?.message ?? 'Save failed'),
        });
    }

    addBodyVar(stageIndex: number): void {
        this.abandonedSettings!.stages[stageIndex].bodyVars.push({ kind: 'static', value: '' });
    }

    removeBodyVar(stageIndex: number, varIndex: number): void {
        this.abandonedSettings!.stages[stageIndex].bodyVars.splice(varIndex, 1);
    }
}

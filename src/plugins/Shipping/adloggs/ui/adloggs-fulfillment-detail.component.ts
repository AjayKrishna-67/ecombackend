import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { UntypedFormGroup } from '@angular/forms';
import { CustomDetailComponent, DataService, NotificationService, SharedModule } from '@vendure/admin-ui/core';
import gql from 'graphql-tag';
import { Observable, Subject, timer } from 'rxjs';
import { filter, switchMap, takeUntil } from 'rxjs/operators';

const GET_ADLOGGS_FULFILLMENTS = gql`
    query GetAdloggsOrderFulfillments($id: ID!) {
        order(id: $id) {
            id
            fulfillments {
                id
                state
                method
                customFields {
                    adloggsOrderUuid
                    adloggsStatus
                    adloggsTrackUrl
                    adloggsRiderName
                    adloggsRiderPhone
                    adloggsFee
                    adloggsError
                }
            }
        }
    }
`;

const SYNC_ADLOGGS_STATUS = gql`
    mutation SyncAdloggsStatus($fulfillmentId: ID!) {
        syncAdloggsStatus(fulfillmentId: $fulfillmentId) {
            success
            message
            statusId
            fulfillmentState
        }
    }
`;

const STATUS_LABELS: Record<number, string> = {
    2: 'Pending',
    3: 'Assigned',
    11: 'Arrived at pickup',
    4: 'Picked up',
    9: 'Out for delivery',
    8: 'Arrived at delivery',
    5: 'Delivered',
    6: 'Cancelled',
    13: 'Return initiated',
    14: 'RTO delivered',
};

const TERMINAL_STATUSES = [5, 6, 13, 14];

interface AdloggsRow {
    fulfillmentId: string;
    state: string;
    uuid: string | null;
    statusId: number | null;
    statusLabel: string;
    problem: boolean;
    trackUrl: string | null;
    riderName: string | null;
    riderPhone: string | null;
    fee: string | null;
    error: string | null;
    syncing: boolean;
}

@Component({
    standalone: true,
    imports: [SharedModule],
    selector: 'vdr-adloggs-fulfillment-detail',
    template: `
        <div *ngIf="rows.length > 0">
            <div *ngFor="let row of rows" class="al-card">
                <div class="al-header">
                    <div class="al-header-left">
                        <span class="al-title">Adloggs Delivery</span>
                        <span class="al-status-badge" [class.problem]="row.problem || (row.error && !row.uuid)">
                            {{ row.error && !row.uuid ? 'Failed' : row.statusLabel }}
                        </span>
                        <span class="al-fulfillment">#{{ row.fulfillmentId }} · {{ row.state }}</span>
                    </div>
                    <button class="al-sync-btn" [disabled]="row.syncing" (click)="sync(row)">
                        {{ row.syncing ? 'Syncing…' : row.uuid ? 'Sync' : 'Retry' }}
                    </button>
                </div>
                <div class="al-body">
                    <div class="fields-grid">
                        <div class="field-item">
                            <span class="field-label">STATUS</span>
                            <span class="field-value status-value">{{ row.statusLabel }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">RIDER</span>
                            <span class="field-value">{{ row.riderName || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">RIDER PHONE</span>
                            <span class="field-value">{{ row.riderPhone || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">DELIVERY FEE</span>
                            <span class="field-value">{{ row.fee ? '₹' + row.fee : 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">ORDER UUID</span>
                            <span class="field-value">{{ row.uuid || 'N/A' }}</span>
                        </div>
                        <div class="field-item" *ngIf="row.trackUrl">
                            <span class="field-label">TRACKING</span>
                            <span class="field-value">
                                <a [href]="row.trackUrl" target="_blank" rel="noreferrer">Live tracking map</a>
                            </span>
                        </div>
                    </div>
                    <div *ngIf="row.error" class="al-error">{{ row.error }}</div>
                </div>
            </div>
        </div>
    `,
    styles: [
        `
            .al-card {
                border: 1px solid var(--color-component-border-200);
                border-radius: 4px;
                margin-bottom: 12px;
                overflow: hidden;
            }
            .al-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 12px;
                background: var(--color-component-bg-200);
            }
            .al-header-left {
                display: flex;
                align-items: center;
                gap: 8px;
                min-width: 0;
            }
            .al-title {
                font-weight: 600;
                font-size: 13px;
            }
            .al-status-badge {
                background: var(--color-primary-100);
                color: var(--color-primary-700);
                border-radius: 3px;
                padding: 2px 8px;
                font-size: 10px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 0.04em;
            }
            .al-status-badge.problem {
                background: var(--color-error-100);
                color: var(--color-error-700);
            }
            .al-fulfillment {
                font-size: 11px;
                color: var(--color-text-300);
            }
            .al-sync-btn {
                border: 1px solid var(--color-component-border-300);
                background: var(--color-component-bg-100);
                color: var(--color-text-100);
                border-radius: 3px;
                padding: 4px 12px;
                font-size: 12px;
                cursor: pointer;
            }
            .al-sync-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            .al-body {
                padding: 12px;
            }
            .fields-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
                gap: 10px 16px;
            }
            .field-item {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            .field-label {
                font-size: 10px;
                font-weight: 600;
                letter-spacing: 0.05em;
                color: var(--color-text-300);
            }
            .field-value {
                font-size: 13px;
                word-break: break-all;
            }
            .status-value {
                color: var(--color-primary-600);
                font-weight: 600;
            }
            .al-error {
                margin-top: 10px;
                padding-top: 10px;
                border-top: 1px solid var(--color-component-border-200);
                color: var(--color-error-500);
                font-size: 12px;
            }
        `,
    ],
})
export class AdloggsFulfillmentDetailComponent implements CustomDetailComponent, OnInit, OnDestroy {
    entity$!: Observable<any>;
    detailForm!: UntypedFormGroup;

    rows: AdloggsRow[] = [];
    private currentOrderId: string | null = null;
    private destroy$ = new Subject<void>();

    constructor(
        private dataService: DataService,
        private notificationService: NotificationService,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit() {
        this.entity$
            .pipe(
                filter((order: any) => !!order?.id),
                switchMap((order: any) => {
                    this.currentOrderId = order.id;
                    return this.dataService
                        .query(GET_ADLOGGS_FULFILLMENTS, { id: order.id })
                        .mapStream((data: any) => data.order?.fulfillments || []);
                }),
                takeUntil(this.destroy$),
            )
            .subscribe((fulfillments: any[]) => {
                this.rows = fulfillments
                    .filter(f => (f?.method ?? '').toLowerCase() === 'adloggs')
                    .map(f => this.toRow(f));
                this.cdr.markForCheck();
            });
        this.startPolling();
    }

    ngOnDestroy() {
        this.destroy$.next();
        this.destroy$.complete();
    }

    /**
     * Webhooks update the fulfillment in the background; poll every 15s while
     * any Adloggs delivery on this order is still in progress so the card
     * follows along without pressing Sync.
     */
    private startPolling() {
        timer(15_000, 15_000)
            .pipe(takeUntil(this.destroy$))
            .subscribe(() => {
                const live = this.rows.some(r => r.uuid && !TERMINAL_STATUSES.includes(r.statusId ?? -1));
                if (live) {
                    this.refresh();
                }
            });
    }

    sync(row: AdloggsRow) {
        row.syncing = true;
        this.cdr.markForCheck();
        this.dataService.mutate(SYNC_ADLOGGS_STATUS, { fulfillmentId: row.fulfillmentId }).subscribe({
            next: (result: any) => {
                row.syncing = false;
                const r = result?.syncAdloggsStatus;
                if (r?.success) {
                    this.notificationService.success(r.message || 'Synced with Adloggs');
                } else {
                    this.notificationService.error(r?.message || 'Sync failed');
                }
                this.refresh();
            },
            error: (err: any) => {
                row.syncing = false;
                this.notificationService.error(err?.message || 'Sync failed');
                this.cdr.markForCheck();
            },
        });
    }

    private refresh() {
        if (!this.currentOrderId) {
            return;
        }
        this.dataService
            .query(GET_ADLOGGS_FULFILLMENTS, { id: this.currentOrderId })
            .single$.subscribe((data: any) => {
                this.rows = (data.order?.fulfillments || [])
                    .filter((f: any) => (f?.method ?? '').toLowerCase() === 'adloggs')
                    .map((f: any) => this.toRow(f));
                this.cdr.markForCheck();
            });
    }

    private toRow(f: any): AdloggsRow {
        const cf = f.customFields || {};
        const statusId = cf.adloggsStatus;
        return {
            fulfillmentId: f.id,
            state: f.state,
            uuid: cf.adloggsOrderUuid || null,
            statusId: statusId ?? null,
            statusLabel:
                statusId != null && statusId !== 0
                    ? STATUS_LABELS[statusId] ?? `Status ${statusId}`
                    : 'Not created',
            problem: [6, 13, 14].includes(statusId),
            trackUrl: cf.adloggsTrackUrl || null,
            riderName: cf.adloggsRiderName || null,
            riderPhone: cf.adloggsRiderPhone || null,
            fee: cf.adloggsFee || null,
            error: cf.adloggsError || null,
            syncing: false,
        };
    }
}

import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { UntypedFormGroup } from '@angular/forms';
import { CustomDetailComponent, SharedModule, DataService, NotificationService } from '@vendure/admin-ui/core';
import { Observable, Subject } from 'rxjs';
import { switchMap, takeUntil, filter, take } from 'rxjs/operators';
import gql from 'graphql-tag';

const GET_SHIPROCKET_DETAILS = gql`
    query GetShiprocketDetailsByVendureOrder($vendureOrderId: ID!) {
        getShiprocketDetailsByVendureOrder(vendureOrderId: $vendureOrderId) {
            id
            channel_order_id
            status
            status_code
            pickup_location
            payment_method
            total
            created_at
            order_date
            shipments {
                id
                awb
                courier
                status
                etd
                weight
            }
            products {
                name
                sku
                quantity
                selling_price
            }
        }
    }
`;

const ASSIGN_AWB = gql`
    mutation AssignShiprocketAwb($shipmentId: Int!, $courierId: Int) {
        assignShiprocketAwb(shipmentId: $shipmentId, courierId: $courierId) {
            success
            awb_code
            courier_name
            message
        }
    }
`;

const GET_INTL_FULFILLMENTS = gql`
    query ShiprocketOrderFulfillments($orderId: ID!) {
        shiprocketOrderFulfillments(orderId: $orderId) {
            fulfillmentId
            state
            shiprocketOrderId
            channelOrderId
            shipmentId
            status
            awb
            courierName
            trackUrl
            length
            breadth
            height
            weightGrams
            lastSyncedAt
        }
    }
`;

const SYNC_INTL_FULFILLMENT = gql`
    mutation SyncShiprocketFulfillment($fulfillmentId: ID!) {
        syncShiprocketFulfillment(fulfillmentId: $fulfillmentId) {
            success
            message
            status
            awb
            errors
        }
    }
`;

interface ShiprocketOrder {
    id: number;
    channel_order_id: string;
    status: string;
    pickup_location: string;
    payment_method: string;
    total: number;
    created_at: string;
    shipment_id: number | null;
    awb: string | null;
    courier: string | null;
    shipment_status: string | null;
    etd: string | null;
    shipping: boolean;
    expanded: boolean;
}

interface IntlShipment {
    fulfillmentId: string;
    cancelled: boolean;
    shiprocketOrderId: string | null;
    channelOrderId: string | null;
    shipmentId: string | null;
    status: string | null;
    awb: string | null;
    courierName: string | null;
    trackUrl: string | null;
    box: string | null;
    weightGrams: number | null;
    lastSyncedAt: string | null;
    syncing: boolean;
    expanded: boolean;
}

@Component({
    standalone: true,
    imports: [SharedModule],
    selector: 'vdr-shiprocket-fulfillment-detail',
    template: `
        <div *ngIf="shiprocketOrders.length > 0">
            <div *ngFor="let order of shiprocketOrders" class="sr-card">
                <div class="sr-header" (click)="order.expanded = !order.expanded">
                    <div class="sr-header-left">
                        <span class="sr-toggle">{{ order.expanded ? '\u25BC' : '\u25B6' }}</span>
                        <span class="sr-title">Shiprocket Quick</span>
                        <span class="sr-status-badge" [class.cancelled]="order.status === 'CANCELED'">{{ order.status || 'N/A' }}</span>
                        <span class="sr-order-id">#{{ order.id }}</span>
                    </div>
                    <div class="sr-header-right">
                        <button
                            class="sr-reload-btn"
                            [disabled]="refreshing"
                            [class.spinning]="refreshing"
                            (click)="onRefresh($event)"
                            title="Reload">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="23 4 23 10 17 10"></polyline>
                                <polyline points="1 20 1 14 7 14"></polyline>
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                            </svg>
                        </button>
                    </div>
                </div>
                <div *ngIf="order.expanded" class="sr-body">
                    <div class="fields-grid">
                        <div class="field-item">
                            <span class="field-label">ORDER ID</span>
                            <span class="field-value">{{ order.id }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">CHANNEL ORDER ID</span>
                            <span class="field-value">{{ order.channel_order_id || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">SHIPMENT ID</span>
                            <span class="field-value">{{ order.shipment_id || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">STATUS</span>
                            <span class="field-value status-value">{{ order.status || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">AWB CODE</span>
                            <span class="field-value">{{ order.awb || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">COURIER</span>
                            <span class="field-value">{{ order.courier || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">PICKUP LOCATION</span>
                            <span class="field-value">{{ order.pickup_location || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">ETD</span>
                            <span class="field-value">{{ order.etd || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">PAYMENT</span>
                            <span class="field-value">{{ order.payment_method || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">SHIPMENT STATUS</span>
                            <span class="field-value status-value">{{ order.shipment_status || 'N/A' }}</span>
                        </div>
                    </div>
                    <div *ngIf="!order.awb && order.shipment_id" class="action-section">
                        <button
                            class="ship-now-btn"
                            [disabled]="order.shipping"
                            (click)="shipNow(order)">
                            {{ order.shipping ? 'Assigning...' : 'Ship Now' }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
        <div *ngIf="intlShipments.length > 0">
            <div *ngFor="let f of intlShipments" class="sr-card">
                <div class="sr-header" (click)="f.expanded = !f.expanded">
                    <div class="sr-header-left">
                        <span class="sr-toggle">{{ f.expanded ? '▼' : '▶' }}</span>
                        <span class="sr-title">Shiprocket International</span>
                        <span class="sr-status-badge" [class.cancelled]="f.cancelled">
                            {{ f.cancelled ? 'CANCELLED' : (f.status || 'N/A') }}
                        </span>
                        <span class="sr-order-id" *ngIf="f.shiprocketOrderId">#{{ f.shiprocketOrderId }}</span>
                    </div>
                    <div class="sr-header-right">
                        <button
                            class="sr-reload-btn"
                            [disabled]="f.syncing"
                            [class.spinning]="f.syncing"
                            (click)="syncIntl(f, $event)"
                            title="Sync from Shiprocket">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="23 4 23 10 17 10"></polyline>
                                <polyline points="1 20 1 14 7 14"></polyline>
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                            </svg>
                        </button>
                    </div>
                </div>
                <div *ngIf="f.expanded" class="sr-body">
                    <div class="fields-grid">
                        <div class="field-item">
                            <span class="field-label">ORDER ID (SENT TO SHIPROCKET)</span>
                            <span class="field-value">{{ f.channelOrderId || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">SHIPROCKET ORDER</span>
                            <span class="field-value">{{ f.shiprocketOrderId || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">SHIPMENT ID</span>
                            <span class="field-value">{{ f.shipmentId || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">AWB CODE</span>
                            <span class="field-value">{{ f.awb || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">COURIER</span>
                            <span class="field-value">{{ f.courierName || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">BOX (L×B×H CM)</span>
                            <span class="field-value">{{ f.box || 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">WEIGHT</span>
                            <span class="field-value">{{ f.weightGrams != null ? f.weightGrams + ' g' : 'N/A' }}</span>
                        </div>
                        <div class="field-item">
                            <span class="field-label">LAST SYNCED</span>
                            <span class="field-value">{{ f.lastSyncedAt ? (f.lastSyncedAt | date: 'medium') : 'N/A' }}</span>
                        </div>
                    </div>
                    <div *ngIf="f.trackUrl" class="action-section">
                        <a [href]="f.trackUrl" target="_blank" rel="noreferrer" class="track-link">Open tracking on Shiprocket</a>
                    </div>
                </div>
            </div>
        </div>
        <div *ngIf="loading" class="loading-state">
            Loading Shiprocket details...
        </div>
    `,
    styles: [`
        .sr-card {
            border: 1px solid var(--color-component-border-200);
            border-radius: 6px;
            margin-bottom: 0.5rem;
            overflow: hidden;
        }
        .sr-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0.6rem 0.75rem;
            cursor: pointer;
            user-select: none;
            background: var(--color-component-bg-100);
        }
        .sr-header:hover {
            background: var(--color-component-bg-200);
        }
        .sr-header-left {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            min-width: 0;
        }
        .sr-header-right {
            flex-shrink: 0;
        }
        .sr-toggle {
            font-size: 0.6rem;
            color: var(--color-text-300);
        }
        .sr-title {
            font-size: 0.8rem;
            font-weight: 600;
            color: var(--color-text-800);
        }
        .sr-status-badge {
            font-size: 0.65rem;
            font-weight: 600;
            padding: 0.1rem 0.4rem;
            border-radius: 3px;
            background: var(--color-primary-100);
            color: var(--color-primary-700);
            text-transform: uppercase;
            letter-spacing: 0.03em;
        }
        .sr-status-badge.cancelled {
            background: var(--color-error-100, #fee2e2);
            color: var(--color-error-600, #dc2626);
        }
        .sr-order-id {
            font-size: 0.75rem;
            color: var(--color-text-300);
        }
        .sr-reload-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            border: none;
            border-radius: 4px;
            background: transparent;
            color: var(--color-text-400);
            cursor: pointer;
            transition: color 0.15s, background 0.15s;
        }
        .sr-reload-btn:hover:not(:disabled) {
            background: var(--color-component-bg-300);
            color: var(--color-text-800);
        }
        .sr-reload-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
        .sr-reload-btn.spinning svg {
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
        .sr-body {
            padding: 0.75rem;
            border-top: 1px solid var(--color-component-border-200);
        }
        .fields-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 0.6rem;
        }
        .field-item {
            display: flex;
            flex-direction: column;
            gap: 0.1rem;
        }
        .field-label {
            font-size: 0.65rem;
            color: var(--color-text-500);
            font-weight: 500;
            letter-spacing: 0.03em;
        }
        .field-value {
            font-size: 0.8rem;
            color: var(--color-text-900);
            font-weight: 500;
            word-break: break-all;
        }
        .status-value {
            color: var(--color-primary-600);
        }
        .loading-state {
            padding: 0.75rem;
            color: var(--color-text-300);
            font-size: 0.8rem;
        }
        .action-section {
            margin-top: 0.6rem;
            padding-top: 0.5rem;
            border-top: 1px solid var(--color-component-border-200);
        }
        .ship-now-btn {
            padding: 0.35rem 1rem;
            background-color: var(--color-primary-500);
            color: #fff;
            border: none;
            border-radius: 4px;
            font-size: 0.8rem;
            font-weight: 600;
            cursor: pointer;
        }
        .ship-now-btn:hover:not(:disabled) {
            background-color: var(--color-primary-600);
        }
        .ship-now-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .track-link {
            font-size: 0.75rem;
            color: var(--color-primary-600);
            text-decoration: underline;
        }
    `]
})
export class ShiprocketFulfillmentDetailComponent implements CustomDetailComponent, OnInit, OnDestroy {
    entity$!: Observable<any>;
    detailForm!: UntypedFormGroup;
    shiprocketOrders: ShiprocketOrder[] = [];
    intlShipments: IntlShipment[] = [];
    loading = false;
    refreshing = false;
    private currentOrderId: string | null = null;
    private destroy$ = new Subject<void>();

    constructor(
        private dataService: DataService,
        private cdr: ChangeDetectorRef,
        private notificationService: NotificationService,
    ) {}

    ngOnInit() {
        this.entity$.pipe(
            filter((order: any) => !!order?.id),
            switchMap((order: any) => {
                this.currentOrderId = order.id;
                this.loading = true;
                this.cdr.markForCheck();
                return this.dataService.query(GET_SHIPROCKET_DETAILS, { vendureOrderId: order.id })
                    .mapStream((data: any) => data.getShiprocketDetailsByVendureOrder || []);
            }),
            takeUntil(this.destroy$),
        ).subscribe((orders: any[]) => {
            this.shiprocketOrders = orders.map((o: any) => ({
                id: o.id,
                channel_order_id: o.channel_order_id,
                status: o.status,
                pickup_location: o.pickup_location,
                payment_method: o.payment_method,
                total: o.total,
                created_at: o.created_at,
                shipment_id: o.shipments?.id || null,
                awb: o.shipments?.awb || null,
                courier: o.shipments?.courier || null,
                shipment_status: o.shipments?.status || null,
                etd: o.shipments?.etd || null,
                shipping: false,
                expanded: false,
            }));
            this.loading = false;
            this.cdr.markForCheck();
        });

        // Shiprocket International shipments (stored on fulfillment custom fields).
        this.entity$.pipe(
            filter((order: any) => !!order?.id),
            switchMap((order: any) =>
                this.dataService.query(GET_INTL_FULFILLMENTS, { orderId: order.id })
                    .mapStream((data: any) => data.shiprocketOrderFulfillments || []),
            ),
            takeUntil(this.destroy$),
        ).subscribe((list: any[]) => {
            this.intlShipments = list.map(f => this.mapIntl(f));
            this.cdr.markForCheck();
        });
    }

    private mapIntl(f: any): IntlShipment {
        const cancelled = f.state === 'Cancelled';
        const existing = this.intlShipments.find(s => s.fulfillmentId === f.fulfillmentId);
        return {
            fulfillmentId: f.fulfillmentId,
            cancelled,
            shiprocketOrderId: f.shiprocketOrderId,
            channelOrderId: f.channelOrderId,
            shipmentId: f.shipmentId,
            status: f.status,
            awb: f.awb,
            courierName: f.courierName,
            trackUrl: f.trackUrl,
            box: f.length != null ? f.length + '×' + f.breadth + '×' + f.height : null,
            weightGrams: f.weightGrams,
            lastSyncedAt: f.lastSyncedAt,
            syncing: false,
            expanded: existing ? existing.expanded : !cancelled,
        };
    }

    syncIntl(f: IntlShipment, event: Event) {
        event.stopPropagation();
        f.syncing = true;
        this.cdr.markForCheck();
        this.dataService.mutate(SYNC_INTL_FULFILLMENT, { fulfillmentId: f.fulfillmentId })
            .pipe(take(1))
            .subscribe({
                next: (result: any) => {
                    const r = result.syncShiprocketFulfillment;
                    if (r?.success) {
                        this.notificationService.success('Synced' + (r.status ? ': ' + r.status : ''));
                    } else {
                        this.notificationService.error(r?.message || 'Sync failed');
                    }
                    f.syncing = false;
                    this.refreshIntl();
                },
                error: () => {
                    this.notificationService.error('Sync failed');
                    f.syncing = false;
                    this.cdr.markForCheck();
                },
            });
    }

    private refreshIntl() {
        if (!this.currentOrderId) {
            return;
        }
        this.dataService.query(GET_INTL_FULFILLMENTS, { orderId: this.currentOrderId })
            .mapStream((data: any) => data.shiprocketOrderFulfillments || [])
            .pipe(take(1))
            .subscribe((list: any[]) => {
                this.intlShipments = list.map(f => this.mapIntl(f));
                this.cdr.markForCheck();
            });
    }

    shipNow(order: ShiprocketOrder) {
        if (!order.shipment_id) {
            return;
        }
        order.shipping = true;
        this.cdr.markForCheck();
        this.dataService.mutate(ASSIGN_AWB, { shipmentId: order.shipment_id })
            .pipe(take(1))
            .subscribe({
                next: (result: any) => {
                    const data = result.assignShiprocketAwb;
                    if (data.success) {
                        this.notificationService.success(data.message || 'Rider assignment in progress');
                    } else {
                        this.notificationService.error(data.message || 'AWB assignment failed');
                    }
                    order.shipping = false;
                    this.refreshData();
                },
                error: (err: any) => {
                    this.notificationService.error('Failed to assign AWB');
                    order.shipping = false;
                    this.cdr.markForCheck();
                },
            });
    }

    onRefresh(event: Event) {
        event.stopPropagation();
        this.refreshing = true;
        this.cdr.markForCheck();
        this.refreshData(() => {
            this.refreshing = false;
            this.cdr.markForCheck();
        });
    }

    private refreshData(callback?: () => void) {
        if (!this.currentOrderId) {
            return;
        }
        this.dataService.query(GET_SHIPROCKET_DETAILS, { vendureOrderId: this.currentOrderId })
            .mapStream((data: any) => data.getShiprocketDetailsByVendureOrder || [])
            .pipe(take(1))
            .subscribe((orders: any[]) => {
                const expandedIds = new Set(this.shiprocketOrders.filter(o => o.expanded).map(o => o.id));
                this.shiprocketOrders = orders.map((o: any) => ({
                    id: o.id,
                    channel_order_id: o.channel_order_id,
                    status: o.status,
                    pickup_location: o.pickup_location,
                    payment_method: o.payment_method,
                    total: o.total,
                    created_at: o.created_at,
                    shipment_id: o.shipments?.id || null,
                    awb: o.shipments?.awb || null,
                    courier: o.shipments?.courier || null,
                    shipment_status: o.shipments?.status || null,
                    etd: o.shipments?.etd || null,
                    shipping: false,
                    expanded: expandedIds.has(o.id),
                }));
                this.cdr.markForCheck();
                if (callback) callback();
            });
    }

    ngOnDestroy() {
        this.destroy$.next();
        this.destroy$.complete();
    }
}

import { Component, OnInit, OnDestroy } from '@angular/core';
import {
    CustomDetailComponent,
    DataService,
    SharedModule,
} from '@vendure/admin-ui/core';
import { Observable, Subject } from 'rxjs';
import { switchMap, map, takeUntil } from 'rxjs/operators';
import { UntypedFormGroup } from '@angular/forms';
import gql from 'graphql-tag';

const GET_ORDER_DELIVERY_ASSIGNMENTS = gql`
    query GetOrderDeliveryAssignments($orderId: ID!) {
        orderDeliveryAssignments(orderId: $orderId) {
            fulfillmentId
            state
            deliveryPersonName
            deliveryPersonPhone
            createdAt
        }
    }
`;

@Component({
    selector: 'delivery-info',
    standalone: true,
    imports: [SharedModule],
    template: `
        <div *ngIf="(deliveryInfo$ | async) as info">
            <div *ngIf="info.length > 0" class="da-section">
                <h4 class="da-title">Delivery Assignments</h4>
                <div *ngFor="let item of info"
                     class="da-card"
                     [ngClass]="'da-card--' + item.stateClass">
                    <div class="da-header">
                        <span class="da-fulfillment-id">
                            &#x1F4E6; Fulfillment #{{ item.fulfillmentId }}
                        </span>
                        <span class="da-badge" [ngClass]="'da-badge--' + item.stateClass">
                            {{ item.stateLabel }}
                        </span>
                    </div>
                    <div class="da-body">
                        <div class="da-row">
                            <span class="da-label">Delivery Person</span>
                            <span class="da-value">{{ item.deliveryPersonName }}</span>
                        </div>
                        <div class="da-row">
                            <span class="da-label">Assigned</span>
                            <span class="da-value">{{ item.createdAt }}</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `,
    styles: [`
        .da-section {
            margin: 1rem 0;
            padding: 1.25rem;
            background: var(--color-component-bg-200, #1e293b);
            border: 1px solid var(--color-component-border-200, #334155);
            border-radius: 8px;
        }

        .da-title {
            font-size: 1rem;
            font-weight: 600;
            color: var(--color-text-100, #f1f5f9);
            margin: 0 0 1rem 0;
            padding: 0;
        }

        .da-card {
            border: 1px solid var(--color-component-border-200, #334155);
            border-radius: 6px;
            margin-bottom: 0.75rem;
            overflow: hidden;
        }

        .da-card:last-child {
            margin-bottom: 0;
        }

        /* ── Cancelled card: coral/orange background ── */
        .da-card--cancelled {
            background: #7f1d1d;
            border-color: #991b1b;
        }

        .da-card--cancelled .da-header {
            background: rgba(0, 0, 0, 0.15);
        }

        .da-card--cancelled .da-body {
            background: #7f1d1d;
        }

        .da-card--cancelled .da-label,
        .da-card--cancelled .da-value {
            color: #fecaca;
        }

        /* ── Assigned card: dark teal tint ── */
        .da-card--assigned {
            background: var(--color-component-bg-100, #0f172a);
            border-color: #115e59;
        }

        /* ── Out for Delivery card ── */
        .da-card--outfordelivery {
            background: var(--color-component-bg-100, #0f172a);
            border-color: #1e40af;
        }

        /* ── Delivered card ── */
        .da-card--delivered {
            background: var(--color-component-bg-100, #0f172a);
            border-color: #166534;
        }

        /* ── Pending card ── */
        .da-card--pending {
            background: var(--color-component-bg-100, #0f172a);
            border-color: #92400e;
        }

        .da-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.5rem 0.75rem;
            background: rgba(255, 255, 255, 0.03);
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }

        .da-fulfillment-id {
            font-weight: 600;
            font-size: 0.8125rem;
            color: var(--color-text-100, #f1f5f9);
        }

        .da-badge {
            font-size: 0.6875rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            padding: 0.125rem 0.5rem;
            border-radius: 4px;
            color: #fff;
        }

        .da-badge--assigned {
            background: #0d9488;
        }

        .da-badge--cancelled {
            background: #dc2626;
        }

        .da-badge--outfordelivery {
            background: #2563eb;
        }

        .da-badge--delivered {
            background: #16a34a;
        }

        .da-badge--pending {
            background: #d97706;
        }

        .da-body {
            padding: 0.5rem 0.75rem;
        }

        .da-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.25rem 0;
        }

        .da-label {
            font-size: 0.8125rem;
            color: var(--color-text-300, #94a3b8);
        }

        .da-value {
            font-size: 0.8125rem;
            font-weight: 600;
            color: var(--color-text-100, #f1f5f9);
        }
    `],
})
export class DeliveryInfoComponent implements CustomDetailComponent, OnInit, OnDestroy {
    entity$!: Observable<any>;
    detailForm!: UntypedFormGroup;
    deliveryInfo$!: Observable<any[]>;
    private destroy$ = new Subject<void>();

    constructor(private dataService: DataService) { }

    ngOnInit() {
        this.deliveryInfo$ = this.entity$.pipe(
            switchMap((order: any) => {
                if (!order?.id) {
                    return [];
                }
                return this.dataService
                    .query(GET_ORDER_DELIVERY_ASSIGNMENTS, { orderId: order.id })
                    .mapStream((result: any) => result.orderDeliveryAssignments || []);
            }),
            map((assignments: any[]) =>
                assignments.map((a: any) => {
                    const { stateLabel, stateClass } = this.getStateInfo(a.state);
                    return {
                        ...a,
                        createdAt: a.createdAt
                            ? new Date(a.createdAt).toLocaleString()
                            : '',
                        stateLabel,
                        stateClass,
                    };
                }),
            ),
            takeUntil(this.destroy$),
        );
    }

    private getStateInfo(state: string): { stateLabel: string; stateClass: string } {
        switch (state) {
            case 'Shipped':
                return { stateLabel: 'ASSIGNED', stateClass: 'assigned' };
            case 'Cancelled':
                return { stateLabel: 'CANCELLED', stateClass: 'cancelled' };
            case 'OutforDelivery':
                return { stateLabel: 'OUT FOR DELIVERY', stateClass: 'outfordelivery' };
            case 'Delivered':
                return { stateLabel: 'DELIVERED', stateClass: 'delivered' };
            case 'Pending':
                return { stateLabel: 'PENDING', stateClass: 'pending' };
            default:
                return { stateLabel: state.toUpperCase(), stateClass: 'assigned' };
        }
    }

    ngOnDestroy() {
        this.destroy$.next();
        this.destroy$.complete();
    }
}


import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { UntypedFormGroup } from '@angular/forms';
import {
  DataService,
  SharedModule,
  CustomDetailComponent,
} from '@vendure/admin-ui/core';
import { Observable, Subject, of, BehaviorSubject } from 'rxjs';
import { map, switchMap, catchError, takeUntil, startWith } from 'rxjs/operators';
import gql from 'graphql-tag';

interface RazorpayPaymentAttempt {
  id: string;
  status: string;
  amount: number;
  method: string;
  createdAt: string;
  errorReason: string | null;
}

interface RazorpayOrderStatus {
  status: string;
  attempts: number;
  amountPaid: number;
  amountDue: number;
  razorpayOrderId: string;
  history: RazorpayPaymentAttempt[];
}

const GET_RAZORPAY_ORDER_STATUS = gql`
  query GetRazorpayOrderStatus($orderId: ID!) {
    getRazorpayOrderStatus(orderId: $orderId) {
      status
      attempts
      amountPaid
      amountDue
      razorpayOrderId
      history {
        id
        status
        amount
        method
        createdAt
        errorReason
      }
    }
  }
`;

@Component({
  standalone: true,
  imports: [SharedModule],
  selector: 'razorpay-order-status',
  template: `
    <vdr-card>
      <div class="card-header">
        <h3>Razorpay Payment Status</h3>
      </div>
      <div class="card-content">
        <div *ngIf="loading$ | async" class="loading-state">
          <div class="spinner"></div>
          <span>Loading payment status...</span>
        </div>

        <div *ngIf="(error$ | async) as error" class="error-state">
          <div class="error-message">{{ error }}</div>
        </div>

        <div *ngIf="status$ | async as status" class="status-content">
          <div class="status-summary">
            <div class="status-item">
              <label>Status:</label>
              <span [class]="'status-badge status-' + (status.status || 'unknown').toLowerCase()">
                {{ status.status || 'Unknown' }}
              </span>
            </div>
            <div class="status-item">
              <label>Payment Attempts:</label>
              <span>{{ status.attempts || 0 }}</span>
            </div>
            <div class="status-item">
              <label>Amount Paid:</label>
              <span class="amount">₹{{ (status.amountPaid || 0) / 100 | number:'1.2-2' }}</span>
            </div>
            <div class="status-item">
              <label>Amount Due:</label>
              <span class="amount">₹{{ (status.amountDue || 0) / 100 | number:'1.2-2' }}</span>
            </div>
            <div class="status-item" *ngIf="status.razorpayOrderId">
              <label>Razorpay Order ID:</label>
              <span class="order-id">{{ status.razorpayOrderId }}</span>
            </div>
          </div>

          <div *ngIf="status.history && status.history.length > 0" class="payment-history">
            <h4>Payment History</h4>
            <vdr-data-table
              [items]="status.history"
              [itemsPerPage]="status.history.length"
              [totalItems]="status.history.length"
              [currentPage]="1"
            >
              <ng-template let-payment="item">
                <td class="left align-middle">
                  <span [class]="'status-badge status-' + payment.status.toLowerCase()">
                    {{ payment.status }}
                  </span>
                </td>
                <td class="left align-middle">
                  ₹{{ (payment.amount || 0) / 100 | number:'1.2-2' }}
                </td>
                <td class="left align-middle">
                  {{ payment.method || 'N/A' }}
                </td>
                <td class="left align-middle">
                  {{ payment.createdAt | date:'short' }}
                </td>
                <td class="left align-middle" *ngIf="payment.errorReason">
                  <span class="error-reason">{{ payment.errorReason }}</span>
                </td>
              </ng-template>
            </vdr-data-table>
          </div>

          <div *ngIf="!status.history || status.history.length === 0" class="no-history">
            <p>No payment attempts recorded.</p>
          </div>
        </div>
      </div>
    </vdr-card>
  `,
  styles: [`
    .card-header {
      padding: 1rem;
      border-bottom: 1px solid var(--color-component-border-200);
    }

    .card-header h3 {
      margin: 0;
      font-size: 1.125rem;
      font-weight: 600;
    }

    .card-content {
      padding: 1rem;
    }

    .loading-state {
      padding: 2rem;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1rem;
    }

    .spinner {
      width: 40px;
      height: 40px;
      border: 4px solid var(--color-component-border-200);
      border-top-color: var(--color-primary-600);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .error-state {
      padding: 1rem;
    }

    .error-message {
      padding: 1rem;
      background-color: #f8d7da;
      border: 1px solid #f5c6cb;
      border-radius: 4px;
      color: #721c24;
    }

    .status-content {
      padding: 0.5rem 0;
    }

    .status-summary {
      margin-bottom: 1.5rem;
    }

    .status-item {
      display: flex;
      justify-content: space-between;
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--color-component-border-200);
    }

    .status-item:last-child {
      border-bottom: none;
    }

    .status-item label {
      font-weight: 600;
      color: var(--color-text-200);
    }

    .status-item span {
      color: var(--color-text-100);
    }

    .status-badge {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      border-radius: 12px;
      font-size: 0.875rem;
      font-weight: 600;
      text-transform: uppercase;
    }

    .status-badge.status-paid,
    .status-badge.status-captured {
      background-color: #d4edda;
      color: #155724;
    }

    .status-badge.status-failed {
      background-color: #f8d7da;
      color: #721c24;
    }

    .status-badge.status-authorize,
    .status-badge.status-authorized {
      background-color: #d1ecf1;
      color: #0c5460;
    }

    .status-badge.status-created,
    .status-badge.status-attempted {
      background-color: #fff3cd;
      color: #856404;
    }

    .status-badge.status-unknown {
      background-color: #e2e3e5;
      color: #383d41;
    }

    .amount {
      font-weight: 600;
      color: var(--color-primary-600);
    }

    .order-id {
      font-family: monospace;
      font-size: 0.875rem;
      color: var(--color-text-200);
    }

    .payment-history {
      margin-top: 1.5rem;
    }

    .payment-history h4 {
      margin-bottom: 1rem;
      font-size: 1rem;
      font-weight: 600;
    }

    .error-reason {
      color: #721c24;
      font-size: 0.875rem;
    }

    .no-history {
      padding: 1rem;
      text-align: center;
      color: var(--color-text-200);
      font-style: italic;
    }
  `],
})
export class RazorpayOrderStatusComponent implements CustomDetailComponent, OnInit, OnDestroy {
  // Required by CustomDetailComponent interface
  // These are injected by Vendure's custom detail component system
  entity$!: Observable<any>;
  detailForm!: UntypedFormGroup;

  orderId: string | null = null;
  status$: Observable<RazorpayOrderStatus | null> = of(null);
  loading$ = new BehaviorSubject<boolean>(true);
  error$ = new BehaviorSubject<string | null>(null);

  private destroy$ = new Subject<void>();

  constructor(
    private dataService: DataService,
    private cdRef: ChangeDetectorRef
  ) {}

  ngOnInit() {
    // Get order ID from entity$ observable
    this.entity$
      .pipe(
        map((order: any) => order?.id),
        takeUntil(this.destroy$)
      )
      .subscribe(id => {
        this.orderId = id;
        if (id) {
          this.loadRazorpayStatus(id);
        }
      });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private loadRazorpayStatus(orderId: string) {
    this.loading$.next(true);
    this.error$.next(null);

    const query$ = this.dataService
      .query(GET_RAZORPAY_ORDER_STATUS, { orderId })
      .mapStream((data: any) => data.getRazorpayOrderStatus);

    this.status$ = query$.pipe(
      catchError((error: any) => {
        console.error('Error loading Razorpay status:', error);
        this.loading$.next(false);
        const errorMessage = error.message || 'Failed to load Razorpay payment status';
        // Check if it's because there's no Razorpay order ID
        if (errorMessage.includes('No Razorpay ID found')) {
          this.error$.next('This order does not have a Razorpay payment associated with it.');
        } else {
          this.error$.next(errorMessage);
        }
        this.cdRef.markForCheck();
        // Return null to indicate no status available
        return of(null);
      }),
      takeUntil(this.destroy$)
    );

    // Update loading state when status is received
    this.status$.subscribe({
      next: (status) => {
        if (status !== null) {
          this.loading$.next(false);
          this.error$.next(null);
        }
        this.cdRef.markForCheck();
      }
    });
  }
}


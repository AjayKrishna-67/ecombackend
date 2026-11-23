import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { Dialog, SharedModule, DataService } from '@vendure/admin-ui/core';
import { Observable, Subject, of, BehaviorSubject } from 'rxjs';
import { catchError, takeUntil } from 'rxjs/operators';
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
  selector: 'razorpay-status-dialog',
  template: `
    <ng-template vdrDialogTitle>Transaction Details</ng-template>

    <div class="transaction-content">
      <div *ngIf="loading$ | async" class="loading-state">
        <div class="spinner"></div>
        <span>Loading payment status...</span>
      </div>

      <div *ngIf="(error$ | async) as error" class="error-state">
        <div class="error-message">{{ error }}</div>
      </div>

      <div *ngIf="status$ | async as status">
        <div class="amount-section">
          <div class="amount">₹{{ (status.amountPaid || 0) / 100 | number:'1.2-2' }}</div>
          <span [class]="'status-badge status-' + (status.status || 'unknown').toLowerCase()">
            {{ status.status || 'UNKNOWN' }}
          </span>
        </div>

        <div class="order-id-row" *ngIf="status.razorpayOrderId">
          <div class="order-id-label">RAZORPAY ORDER ID</div>
          <div class="order-id-content">
            <span class="order-id">{{ status.razorpayOrderId }}</span>
            <button class="copy-btn" (click)="copyToClipboard(status.razorpayOrderId)" title="Copy to clipboard">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/>
                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/>
              </svg>
            </button>
          </div>
        </div>

        <div class="attempts-row">
            <div class="attempts-label">ATTEMPTS</div>
            <div class="attempts-value">{{ status.attempts || 0 }}</div>
        </div>

        <div class="history-section" *ngIf="status.history && status.history.length > 0">
          <h3 class="section-title">Payment History</h3>
          
          <div class="history-list">
            <div *ngFor="let payment of status.history" class="payment-item">
              <div class="payment-row">
                <div class="payment-left">
                  <div class="status-icon" [ngClass]="'status-' + payment.status.toLowerCase()">
                    <svg *ngIf="payment.status.toLowerCase() === 'failed'" width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    </svg>
                    <svg *ngIf="payment.status.toLowerCase() === 'captured' || payment.status.toLowerCase() === 'paid'" width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </div>
                  <div class="payment-details">
                    <div class="payment-title">Payment {{ payment.status }}</div>
                    <div class="payment-meta">{{ payment.createdAt | date:'M/d/yy, h:mm a' }} • {{ payment.method || 'N/A' }}</div>
                  </div>
                </div>
                <div class="payment-amount">₹{{ (payment.amount || 0) / 100 | number:'1.2-2' }}</div>
              </div>
              
              <div *ngIf="payment.errorReason" class="error-message-box">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                  <path d="M12 8v4m0 4h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
                <span>{{ payment.errorReason }}</span>
              </div>
            </div>
          </div>
        </div>

        <div *ngIf="!status.history || status.history.length === 0" class="empty-state">
          <p>No payment attempts recorded.</p>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .transaction-content {
      padding: 1.25rem;
    }

    /* Loading State */
    .loading-state {
      padding: 3rem;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1rem;
    }

    .spinner {
      width: 40px;
      height: 40px;
      border: 4px solid var(--color-component-border-300);
      border-top-color: var(--color-primary-500);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Error State */
    .error-state {
      padding: 2rem;
      text-align: center;
    }

    .error-message {
      padding: 1rem;
      background-color: var(--color-error-100);
      border: 1px solid var(--color-error-300);
      border-radius: 8px;
      color: var(--color-error-700);
    }

    /* Amount Section */
    .amount-section {
      background: var(--color-component-bg-200);
      padding: 1.25rem;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1rem;
    }

    .amount {
      font-size: 1.75rem;
      font-weight: 700;
      color: var(--color-text-100);
    }

    .status-badge {
      padding: 0.375rem 0.75rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.025em;
    }

    .status-badge.status-paid,
    .status-badge.status-captured {
      background-color: #10b981;
      color: #ffffff;
    }

    .status-badge.status-failed {
      background-color: #ef4444;
      color: #ffffff;
    }

    .status-badge.status-authorized {
      background-color: #3b82f6;
      color: #ffffff;
    }

    .status-badge.status-created,
    .status-badge.status-attempted {
      background-color: #f59e0b;
      color: #ffffff;
    }

    .status-badge.status-unknown {
      background-color: #6b7280;
      color: #ffffff;
    }

    /* Order ID Row (no box) */
    .order-id-row {
      padding: 0.75rem 0;
      border-bottom: 1px solid var(--color-component-border-300);
    }

    .order-id-label {
      font-size: 0.625rem;
      font-weight: 600;
      color: var(--color-text-300);
      margin-bottom: 0.375rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .order-id-content {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }

    .order-id {
      font-family: monospace;
      font-size: 0.8125rem;
      color: var(--color-text-100);
      word-break: break-all;
      flex: 1;
    }

    .copy-btn {
      background: none;
      border: none;
      padding: 0.375rem;
      cursor: pointer;
      color: var(--color-text-300);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
      border-radius: 4px;
      flex-shrink: 0;
    }

    .copy-btn:hover {
      color: var(--color-primary-500);
      background: var(--color-component-bg-200);
    }

    /* NEW: Attempts Row Styles */
    .attempts-row {
        padding: 0.75rem 0;
        border-bottom: 1px solid var(--color-component-border-300);
        margin-bottom: 1rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .attempts-label {
        font-size: 0.625rem;
        font-weight: 600;
        color: var(--color-text-300);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }
    .attempts-value {
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--color-text-100);
    }

    /* History Section */
    .history-section {
      margin-top: 0.5rem;
    }

    .section-title {
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--color-text-100);
      margin: 0 0 0.75rem 0;
    }

    .history-list {
      display: flex;
      flex-direction: column;
      gap: 0.625rem;
    }

    /* Payment Item */
    .payment-item {
      border: 1px solid var(--color-component-border-300);
      border-radius: 6px;
      padding: 0.875rem;
      background: var(--color-component-bg-100);
    }

    .payment-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 0.75rem;
    }

    .payment-left {
      display: flex;
      gap: 0.625rem;
      flex: 1;
    }

    .status-icon {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .status-icon.status-failed {
      background: #fee2e2;
      color: #dc2626;
    }

    .status-icon.status-captured,
    .status-icon.status-paid {
      background: #d1fae5;
      color: #059669;
    }

    .status-icon.status-authorized {
      background: #dbeafe;
      color: #2563eb;
    }

    .payment-details {
      flex: 1;
      min-width: 0;
    }

    .payment-title {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--color-text-100);
      margin-bottom: 0.125rem;
    }

    .payment-meta {
      font-size: 0.6875rem;
      color: var(--color-text-300);
    }

    .payment-amount {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--color-text-100);
      white-space: nowrap;
    }

    /* Error Message Box */
    .error-message-box {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      padding: 0.625rem;
      background: var(--color-error-100);
      border-left: 2px solid var(--color-error-500);
      border-radius: 4px;
      margin-top: 0.625rem;
    }

    .error-message-box svg {
      flex-shrink: 0;
      color: var(--color-error-500);
      margin-top: 1px;
    }

    .error-message-box span {
      font-size: 0.75rem;
      color: var(--color-error-700);
      line-height: 1.4;
    }

    /* Empty State */
    .empty-state {
      padding: 2rem;
      text-align: center;
      color: var(--color-text-300);
      font-size: 0.875rem;
    }
  `],
})
export class RazorpayStatusDialogComponent implements Dialog<void>, OnInit, OnDestroy {
  // Injected by Vendure's Dialog system
  resolveWith!: (result?: void) => void;

  // This will be set by the 'locals' option in ModalService.fromComponent
  orderId?: string;

  status$: Observable<RazorpayOrderStatus | null> = of(null);
  loading$ = new BehaviorSubject<boolean>(true);
  error$ = new BehaviorSubject<string | null>(null);

  private destroy$ = new Subject<void>();

  constructor(
    private dataService: DataService,
    private cdRef: ChangeDetectorRef
  ) {}

  ngOnInit() {
    // Load Razorpay status if order ID is available
    if (this.orderId) {
      this.loadRazorpayStatus(this.orderId);
    } else {
      this.loading$.next(false);
      this.error$.next('Order ID not found');
    }
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
        if (errorMessage.includes('No Razorpay ID found')) {
          this.error$.next('This order does not have a Razorpay payment associated with it.');
        } else {
          this.error$.next(errorMessage);
        }
        return of(null);
      }),
      takeUntil(this.destroy$)
    );

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

  copyToClipboard(text: string) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        console.log('Copied to clipboard');
      }).catch(err => {
        console.error('Failed to copy:', err);
      });
    }
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
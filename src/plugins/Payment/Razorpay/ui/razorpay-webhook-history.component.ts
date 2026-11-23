import { Component } from '@angular/core';
import {
    OrderDetailFragment,
    OrderHistoryEntryComponent,
    SharedModule,
    TimelineDisplayType,
    TimelineHistoryEntry,
} from '@vendure/admin-ui/core';

@Component({
    selector: 'razorpay-webhook-history',
    template: `
        <vdr-history-entry-detail>
            <div class="webhook-card">
                <div class="card-header">
                    <div class="header-left">
                        <clr-icon shape="cloud-traffic" class="header-icon"></clr-icon>
                        <span class="header-title">Razorpay Webhook Data</span>
                    </div>
<span class="header-time">{{ entry.createdAt | date:'mediumTime' }}</span>
                </div>

                <div class="card-grid">
                    
                    <div class="grid-item highlight-box">
                        <label>Amount Received</label>
                        <div class="amount-text">
                            ₹{{ (entry.data.amount / 100) | number:'1.2-2' }}
                        </div>
                    </div>

                    <div class="grid-item">
                        <label>Current Status</label>
                        <span class="status-pill" [class]="entry.data.status">
                            {{ entry.data.status }}
                        </span>
                    </div>

                    <div class="grid-item full-width">
                        <label>Webhook Event</label>
                        <div class="value-text">{{ getEventDisplayName(entry.data?.webhookEvent) }}</div>
                    </div>

                    <div class="grid-item">
                        <label>Razorpay Order ID</label>
                        <div class="value-code">{{ entry.data.razorpayOrderId }}</div>
                    </div>
                    <div class="grid-item">
                        <label>Payment ID</label>
                        <div class="value-code">{{ entry.data.paymentId }}</div>
                    </div>

                </div>
            </div>
        </vdr-history-entry-detail>
    `,
    styles: [`
        /* Card Container */
        .webhook-card {
            background-color: var(--color-component-bg-100);
            border: 1px solid var(--color-component-border-200);
            border-radius: 8px;
            padding: 12px;
            margin-top: 4px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.05);
        }

        /* Header Styling */
        .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 1px dashed var(--color-component-border-200);
        }
        .header-left {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .header-icon {
            color: var(--color-primary-500);
        }
        .header-title {
            font-size: 12px;
            font-weight: 700;
            color: var(--color-text-200);
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .header-time {
            font-size: 11px;
            color: var(--color-text-300);
        }

        /* Grid Layout */
        .card-grid {
            display: grid;
            grid-template-columns: 1fr 1fr; /* Two columns */
            gap: 12px;
        }
        .grid-item {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .grid-item.full-width {
            grid-column: 1 / -1; /* Span full width */
        }

        /* Labels & Values */
        label {
            font-size: 10px;
            font-weight: 600;
            color: var(--color-text-300);
            text-transform: uppercase;
        }
        .value-text {
            font-size: 13px;
            color: var(--color-text-100);
        }
        .value-code {
            font-family: 'Consolas', monospace;
            font-size: 12px;
            color: var(--color-text-200);
            word-break: break-all;
        }

        /* Highlight Box (Amount) */
        .highlight-box {
            background: var(--color-primary-50);
            padding: 8px;
            border-radius: 6px;
            border: 1px solid var(--color-primary-100);
        }
        .amount-text {
            font-size: 18px;
            font-weight: 800;
            color: var(--color-primary-700);
        }

        /* Status Pills */
        .status-pill {
            display: inline-flex;
            align-items: center;
            padding: 2px 10px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            width: fit-content;
        }
        .status-pill.captured, .status-pill.paid {
            background-color: var(--color-success-100);
            color: var(--color-success-700);
            border: 1px solid var(--color-success-200);
        }
        .status-pill.failed {
            background-color: var(--color-error-100);
            color: var(--color-error-700);
            border: 1px solid var(--color-error-200);
        }
    `],
    standalone: true,
    imports: [SharedModule],
})
export class RazorpayWebhookHistoryComponent implements OrderHistoryEntryComponent {
    // Injected by Vendure's OrderHistoryEntryComponent system
    entry!: TimelineHistoryEntry;
    order!: OrderDetailFragment;

    /**
     * 1. Display Type: Controls the color of the timeline dot.
     */
    getDisplayType(_entry: TimelineHistoryEntry): TimelineDisplayType {
        const event = this.entry.data?.webhookEvent || '';
        if (event.includes('failed')) {
            return 'error';
        }
        return 'success';
    }

    /**
     * 2. Icon Shape: Adds the ICON to the main timeline axis.
     * 'cloud-traffic' is perfect for webhooks.
     */
    getIconShape(_entry: TimelineHistoryEntry) {
        return 'cloud-traffic';
    }

    /**
     * 3. Name: Controls the main text on the timeline.
     */
    getName(_entry: TimelineHistoryEntry): string {
        return 'Razorpay Webhook';
    }

    isFeatured(_entry: TimelineHistoryEntry): boolean {
        return true;
    }

    getEventDisplayName(event: string): string {
        if (!event) return 'Webhook Processed';
        return event.split('.').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
}
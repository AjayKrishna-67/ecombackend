import { Component } from '@angular/core';
import {
    OrderDetailFragment,
    OrderHistoryEntryComponent,
    SharedModule,
    TimelineDisplayType,
    TimelineHistoryEntry,
} from '@vendure/admin-ui/core';

import { ORDER_LINE_PRICE_UPDATED } from '../../../history-entry.constant';

interface DisplayablePriceChange {
    orderLineId: string;
    productName: string;
    previousUnitPrice: number;
    newUnitPrice: number;
}

@Component({
    selector: 'vdr-price-update-history-entry',
    template: `
        <div class="price-update-entry">
            <div *ngFor="let change of changes()" class="price-update-entry__row">
                <div class="price-update-entry__product">{{ change.productName }}</div>
                <div class="price-update-entry__meta">
                    <span class="price-update-entry__label">OrderLine {{ change.orderLineId }}</span>
                    <span class="price-update-entry__value"
                        >{{ format(change.previousUnitPrice) }} -> {{ format(change.newUnitPrice) }}</span
                    >
                </div>
            </div>

            <vdr-history-entry-detail *ngIf="entry?.data">
                <vdr-object-tree [value]="entry.data"></vdr-object-tree>
            </vdr-history-entry-detail>
        </div>
    `,
    styles: [
        `
        .price-update-entry__row {
            display: flex;
            flex-direction: column;
            gap: 0.125rem;
            margin-bottom: 0.75rem;
        }

        .price-update-entry__product {
            font-weight: 600;
        }

        .price-update-entry__meta {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
            color: var(--color-text-500);
        }

        .price-update-entry__label {
            font-size: 0.85rem;
        }

        .price-update-entry__value {
            font-family: var(--font-family-monospace);
            font-size: 0.85rem;
        }
    `,
    ],
    standalone: true,
    imports: [SharedModule],
})
export class PriceUpdateHistoryEntryComponent implements OrderHistoryEntryComponent {
    entry: TimelineHistoryEntry;
    order: OrderDetailFragment;
    readonly historyType = ORDER_LINE_PRICE_UPDATED;

    get changes(): DisplayablePriceChange[] {
        const changes: DisplayablePriceChange[] = [];
        const rawChanges = (this.entry?.data as any)?.changes as
            | Array<{
                  orderLineId: string;
                  previousUnitPrice: number;
                  newUnitPrice: number;
              }>
            | undefined;

        if (!rawChanges?.length || !this.order?.lines) {
            return changes;
        }

        for (const change of rawChanges) {
            const line = this.order.lines.find((l) => l.id === change.orderLineId);
            const productName = line?.productVariant?.name ?? `OrderLine ${change.orderLineId}`;
            changes.push({
                orderLineId: change.orderLineId,
                productName,
                previousUnitPrice: change.previousUnitPrice,
                newUnitPrice: change.newUnitPrice,
            });
        }

        return changes;
    }

    getDisplayType(): TimelineDisplayType {
        return 'default';
    }

    isFeatured(): boolean {
        return false;
    }

    getName(): string {
        return 'Price Update Plugin';
    }

    getIconShape(): string {
        return 'refresh';
    }

    format(amount: number): string {
        const currency = this.order?.currencyCode ?? (this.entry?.data as any)?.currencyCode ?? '';
        const formatted = (amount / 100).toFixed(2);
        return currency ? `${currency} ${formatted}` : formatted;
    }
}


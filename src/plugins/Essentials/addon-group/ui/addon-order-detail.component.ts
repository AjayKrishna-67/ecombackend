import { Component, OnInit, OnDestroy, ChangeDetectorRef, ChangeDetectionStrategy } from '@angular/core';
import { UntypedFormGroup } from '@angular/forms';
import { SharedModule, CustomDetailComponent, DataService } from '@vendure/admin-ui/core';
import { Observable } from 'rxjs';
import { switchMap, filter } from 'rxjs/operators';
import gql from 'graphql-tag';

interface AddonSelectionItem {
    itemId: string;
    itemName: string;
    quantity: number;
    unitPrice: number;
    imageUrl: string | null;
    enabled: boolean;
}

interface AddonGroupSelection {
    groupId: string;
    groupName: string;
    selectionType: string;
    items: AddonSelectionItem[];
    enabled: boolean;
}

interface OrderLineWithAddons {
    id: string;
    productVariant: { name: string };
    addonSelections: AddonGroupSelection[];
    addonsAvailable: boolean;
}

const GET_ORDER_ADDON_SELECTIONS = gql`
    query GetOrderAddonSelections($id: ID!) {
        order(id: $id) {
            id
            lines {
                id
                productVariant {
                    name
                }
                addonsAvailable
                addonSelections {
                    groupId
                    groupName
                    selectionType
                    enabled
                    items {
                        itemId
                        itemName
                        quantity
                        unitPrice
                        imageUrl
                        enabled
                    }
                }
            }
        }
    }
`;

@Component({
    standalone: true,
    imports: [SharedModule],
    selector: 'addon-order-detail',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: ``,
    styles: [`
        :host {
            display: block;
        }
        .totals-with-addons {
            margin-top: 12px;
            padding: 12px 16px;
            border: 1px solid var(--color-component-border-200);
            border-radius: 4px;
            background: var(--color-component-bg-100);
            max-width: 360px;
        }
        .totals-with-addons .row {
            display: flex;
            justify-content: space-between;
            font-size: 13px;
            color: var(--color-text-200);
            padding: 4px 0;
        }
        .totals-with-addons .row.total {
            border-top: 1px solid var(--color-component-border-200);
            margin-top: 4px;
            padding-top: 8px;
            font-size: 14px;
            font-weight: 700;
            color: var(--color-text-100);
        }
        .totals-with-addons .label {
            color: var(--color-text-300);
        }
        .totals-with-addons .row.total .label {
            color: var(--color-text-100);
        }
        .addon-summary {
            border: 1px solid var(--color-component-border-200);
            border-radius: 4px;
            overflow: hidden;
        }
        .addon-line-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 20px;
            border-bottom: 1px solid var(--color-component-border-100);
            gap: 12px;
        }
        .addon-line-row:last-child {
            border-bottom: none;
        }
        .addon-label {
            font-size: 13px;
            font-weight: 600;
            color: var(--color-text-100);
            white-space: nowrap;
        }
        .addon-items-list {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            flex: 1;
            justify-content: flex-end;
            padding: 0 12px;
        }
        .addon-chip {
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 10px;
            background: var(--color-component-bg-200);
            color: var(--color-text-300);
            white-space: nowrap;
        }
        .addon-amount {
            font-size: 14px;
            font-weight: 600;
            color: var(--color-text-100);
            white-space: nowrap;
            min-width: 80px;
            text-align: right;
        }
        .addon-total-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 20px;
            border-top: 2px solid var(--color-component-border-200);
            background: var(--color-component-bg-200);
        }
        .addon-total-label {
            font-size: 14px;
            font-weight: 700;
            color: var(--color-text-100);
        }
        .addon-total-amount {
            font-size: 14px;
            font-weight: 700;
            color: var(--color-primary-600);
            min-width: 80px;
            text-align: right;
        }
    `],
})
export class AddonOrderDetailComponent implements CustomDetailComponent, OnInit, OnDestroy {
    entity$!: Observable<any>;
    detailForm!: UntypedFormGroup;
    linesWithAddons: OrderLineWithAddons[] = [];
    currencyCode = 'INR';
    private observer?: MutationObserver;

    constructor(
        private dataService: DataService,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit(): void {
        this.entity$.pipe(
            filter((order: any) => !!order?.id),
            switchMap((order: any) => {
                this.currencyCode = order.currencyCode || 'INR';
                return this.dataService
                    .query(GET_ORDER_ADDON_SELECTIONS, { id: order.id })
                    .mapSingle((data: any) => data.order);
            }),
        ).subscribe((order: any) => {
            if (!order) {
                this.linesWithAddons = [];
            } else {
                this.linesWithAddons = (order.lines || []).filter(
                    (l: OrderLineWithAddons) => l.addonSelections && l.addonSelections.length > 0,
                );
                this.currencyCode = order.currencyCode || this.currencyCode;
            }
            this.cdr.markForCheck();
            this.scheduleInject();
        });
        this.startObserver();
    }

    ngOnDestroy(): void {
        this.observer?.disconnect();
        this.removeInjectedRows();
    }

    private startObserver(): void {
        this.observer = new MutationObserver(() => this.injectAddonRows());
        this.observer.observe(document.body, { subtree: true, childList: true });
    }

    private scheduleInject(): void {
        setTimeout(() => this.injectAddonRows(), 0);
    }

    private removeInjectedRows(): void {
        document.querySelectorAll('tr[data-addon-row]').forEach(r => r.remove());
        document.querySelectorAll('[data-addon-inline-for]').forEach(el => el.remove());
        document.querySelectorAll('[data-addon-injected]').forEach(el => el.removeAttribute('data-addon-injected'));
        document.querySelectorAll('[data-addon-out-of-stock]').forEach(el => el.remove());
        document.querySelectorAll('tr[data-addon-surcharge-hidden], [data-addon-surcharge-hidden]').forEach(r => {
            (r as HTMLElement).style.display = '';
            r.removeAttribute('data-addon-surcharge-hidden');
        });
    }

    private hideAddonSurchargeRows(): void {
        const elements = Array.from(document.querySelectorAll('tr, [class*="surcharge"]')) as HTMLElement[];
        for (const el of elements) {
            if (el.hasAttribute('data-addon-surcharge-hidden')) continue;
            // Don't touch our own injected inline addon wrappers or any container that holds them.
            if (el.querySelector('[data-addon-inline-for]')) continue;
            const text = el.textContent || '';
            if (text.includes('ADDON-')) {
                el.setAttribute('data-addon-surcharge-hidden', 'true');
                el.style.display = 'none';
            }
        }
    }

    private injectAddonRows(): void {
        this.hideAddonSurchargeRows();
        if (this.linesWithAddons.length === 0) return;
        const rows = Array.from(document.querySelectorAll('tr')) as HTMLTableRowElement[];
        if (rows.length === 0) return;

        for (const line of this.linesWithAddons) {
            const lineId = String(line.id);
            if (document.querySelector(`[data-addon-inline-for="${lineId}"]`)) continue;
            const targetRow = rows.find(r =>
                !r.hasAttribute('data-addon-injected') &&
                !r.hasAttribute('data-addon-surcharge-hidden') &&
                r.textContent?.includes(line.productVariant.name),
            );
            if (!targetRow) continue;
            targetRow.setAttribute('data-addon-injected', lineId);

            const productCell = Array.from(targetRow.children).find(c =>
                (c as HTMLElement).textContent?.includes(line.productVariant.name),
            ) as HTMLElement | undefined;
            if (!productCell) continue;

            // If any addon attached to this line is disabled, mark the whole line
            // as out-of-stock: dim/strike the product-name container and add a
            // visible badge. Same treatment as a discontinued product variant.
            if (line.addonsAvailable === false) {
                const nameNode = Array.from(productCell.children).find(c =>
                    (c as HTMLElement).textContent?.trim() === line.productVariant.name,
                ) as HTMLElement | undefined;
                const target = nameNode || productCell;
                target.style.textDecoration = 'line-through';
                target.style.opacity = '0.6';
                if (!productCell.querySelector('[data-addon-out-of-stock]')) {
                    const badge = document.createElement('span');
                    badge.setAttribute('data-addon-out-of-stock', 'true');
                    badge.textContent = 'Out of stock';
                    badge.style.cssText = 'display:inline-block;margin-left:8px;padding:2px 6px;border-radius:4px;background:var(--color-error-200,#fce4e4);color:var(--color-error-700,#a40000);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;vertical-align:middle;';
                    productCell.insertBefore(badge, productCell.firstChild);
                }
            }

            const items = this.getAllItems(line);

            const wrapper = document.createElement('div');
            wrapper.setAttribute('data-addon-inline-for', lineId);
            wrapper.style.cssText = 'margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;';

            const label = document.createElement('span');
            label.textContent = 'Addons';
            label.style.cssText = 'font-weight:600;color:var(--color-text-200,#666);text-transform:uppercase;letter-spacing:0.5px;';
            wrapper.appendChild(label);

            // Per-unit addon total for this line (Σ unitPrice × quantity).
            // Addons are baked into the line's unitPrice, so this is how much of
            // the line's unit price is attributable to addons.
            let perUnitAddonTotal = 0;

            for (const item of items) {
                const chip = document.createElement('span');
                const qtyLabel = item.quantity > 1 ? ` ×${item.quantity}` : '';
                const lineContribution = (item.unitPrice || 0) * (item.quantity || 0);
                perUnitAddonTotal += lineContribution;
                const priceLabel = item.unitPrice ? ` · ${this.formatPrice(lineContribution)}` : '';
                if (item.enabled === false) {
                    chip.style.cssText = 'padding:2px 8px;border-radius:10px;background:var(--color-component-bg-200,#eee);color:var(--color-text-300,#999);white-space:nowrap;text-decoration:line-through;opacity:0.7;';
                    chip.title = 'Out of stock';
                    chip.textContent = `${item.itemName}${qtyLabel}${priceLabel} — Out of stock`;
                } else {
                    chip.style.cssText = 'padding:2px 8px;border-radius:10px;background:var(--color-component-bg-200,#eee);color:var(--color-text-300,#333);white-space:nowrap;';
                    chip.textContent = `${item.itemName}${qtyLabel}${priceLabel}`;
                }
                wrapper.appendChild(chip);
            }

            // Emphasised "+₹total" chip so the admin can see, at a glance, how much
            // the addons add to each unit of this line.
            if (perUnitAddonTotal > 0) {
                const totalChip = document.createElement('span');
                totalChip.style.cssText = 'padding:2px 8px;border-radius:10px;background:var(--color-primary-100,#e6f0ff);color:var(--color-primary-600,#0a5);font-weight:700;white-space:nowrap;';
                totalChip.textContent = `+${this.formatPrice(perUnitAddonTotal)}`;
                totalChip.title = 'Addon total per unit (included in the line price)';
                wrapper.appendChild(totalChip);
            }

            productCell.appendChild(wrapper);
        }
    }

    getAllItems(line: OrderLineWithAddons): AddonSelectionItem[] {
        const items: AddonSelectionItem[] = [];
        for (const group of line.addonSelections) {
            items.push(...group.items);
        }
        return items;
    }

    /** Formats a minor-unit amount (e.g. paise) as a localized currency string. */
    private formatPrice(minorUnits: number): string {
        const major = (minorUnits || 0) / 100;
        try {
            return new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency: this.currencyCode,
            }).format(major);
        } catch {
            return `${this.currencyCode} ${major.toFixed(2)}`;
        }
    }
}

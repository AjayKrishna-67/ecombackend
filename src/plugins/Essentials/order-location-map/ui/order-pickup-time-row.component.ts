import { Component, ElementRef, OnDestroy, OnInit } from '@angular/core';
import { FormGroup } from '@angular/forms';
import { CustomDetailComponent } from '@vendure/admin-ui/core';
import { Observable, Subscription } from 'rxjs';

const MARKER_ATTR = 'data-take-away-pickup-time';

/**
 * Puts a Take Away order's pickup time into the order table's Shipping row,
 * right after the shipping method chip: `[Take away] [🕒 2:30 PM]`.
 *
 * The Angular admin's order table (`vdr-order-table`) has no extension point
 * inside its rows, so this registered detail component renders nothing of
 * its own and instead writes a small chip into the table's DOM. It keys on
 * the row's own `tr.shipping` class, re-applies whenever the table re-renders
 * (column changes, order refresh), and is idempotent: one chip, updated in
 * place, removed again when the order is not Take Away.
 */
@Component({
    selector: 'order-pickup-time-row',
    standalone: true,
    template: ``,
})
export class OrderPickupTimeRowComponent implements CustomDetailComponent, OnInit, OnDestroy {
    entity$!: Observable<any>;
    detailForm!: FormGroup;

    private sub?: Subscription;
    private observer?: MutationObserver;
    private order: any;
    private retryTimers: number[] = [];

    constructor(private el: ElementRef<HTMLElement>) {}

    ngOnInit() {
        this.sub = this.entity$.subscribe(order => {
            this.order = order;
            this.scheduleApply();
        });
        // The table re-renders its rows on column visibility changes and on
        // order refreshes, which drops the injected chip; put it back.
        const table = this.findTable();
        if (table && typeof MutationObserver !== 'undefined') {
            this.observer = new MutationObserver(() => this.scheduleApply());
            this.observer.observe(table, { childList: true, subtree: true });
        }
    }

    ngOnDestroy() {
        this.sub?.unsubscribe();
        this.observer?.disconnect();
        this.retryTimers.forEach(t => window.clearTimeout(t));
        this.findChip()?.remove();
    }

    private findTable(): HTMLElement | null {
        // Scope to this detail page, not the whole document, in case two
        // order pages are ever mounted (e.g. a modal).
        const page = this.el.nativeElement.closest('vdr-order-detail') ?? document;
        return page.querySelector('vdr-order-table') as HTMLElement | null;
    }

    private findChip(): HTMLElement | null {
        return this.findTable()?.querySelector(`[${MARKER_ATTR}]`) ?? null;
    }

    private scheduleApply() {
        // The table renders after the entity emits; try now and shortly after.
        this.retryTimers.forEach(t => window.clearTimeout(t));
        this.retryTimers = [0, 250, 1000].map(delay => window.setTimeout(() => this.apply(), delay));
    }

    private apply() {
        const cf = this.order?.customFields;
        const pickupTime: string | null = cf?.isTakeAway && cf?.pickupTime ? String(cf.pickupTime) : null;
        const cell = this.findTable()?.querySelector('tr.shipping td:nth-child(2)') as HTMLElement | null;
        const existing = this.findChip();

        if (!pickupTime || !cell) {
            existing?.remove();
            return;
        }
        const chip = existing ?? this.createChip();
        if (chip.parentElement !== cell) {
            cell.appendChild(chip);
        }
        const label = chip.querySelector('[data-label]') as HTMLElement | null;
        if (label && label.textContent !== pickupTime) {
            label.textContent = pickupTime;
        }
    }

    private createChip(): HTMLElement {
        // Inline styles on purpose: vdr-chip's styles are scoped to that
        // component and cannot be reused from outside Angular.
        const chip = document.createElement('span');
        chip.setAttribute(MARKER_ATTR, '');
        chip.title = 'Pickup time chosen by the customer';
        chip.style.cssText = [
            'display:inline-flex',
            'align-items:center',
            'gap:4px',
            'margin-inline-start:6px',
            'padding:2px 8px',
            'border:1px solid var(--color-component-border-200, #d1d5db)',
            'border-radius:var(--border-radius, 3px)',
            'background:var(--color-component-bg-100, #fff)',
            'font-size:var(--font-size-xs, 12px)',
            'line-height:18px',
            'vertical-align:middle',
        ].join(';');
        const icon = document.createElement('clr-icon');
        icon.setAttribute('shape', 'clock');
        icon.setAttribute('size', '14');
        const label = document.createElement('span');
        label.setAttribute('data-label', '');
        chip.appendChild(icon);
        chip.appendChild(label);
        return chip;
    }
}

import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { FormControl } from '@angular/forms';
import { DataService, FormInputComponent, SharedModule } from '@vendure/admin-ui/core';
import { forkJoin, Observable, of, Subscription } from 'rxjs';
import { map, startWith, switchMap } from 'rxjs/operators';

interface Row {
    id: string;
    name: string;
    sku: string;
    preview?: string;
    quantity: number;
}

/**
 * Editor for the free_product action's `productVariantIds`: search to add a
 * product, then a count box per product. The count is stored by repeating
 * the id, so "2 x Onion" is ["1278","1278"]; the server gives away one unit
 * per listing.
 */
@Component({
    selector: 'free-product-quantity-input',
    standalone: true,
    imports: [SharedModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <ul class="list-unstyled">
            <li *ngFor="let row of rows$ | async" class="row">
                <div class="thumb"><img *ngIf="row.preview" [src]="row.preview + '?preset=tiny'" /></div>
                <div class="detail">
                    <div>{{ row.name }}</div>
                    <div class="sku">{{ row.sku }}</div>
                </div>
                <div class="flex-spacer"></div>
                <div class="qty">
                    <button type="button" class="button-small" [disabled]="readonly || row.quantity <= 1"
                        (click)="setQuantity(row.id, row.quantity - 1)">−</button>
                    <input type="number" min="1" step="1" class="qty-input" [readonly]="readonly"
                        [value]="row.quantity" (change)="setQuantity(row.id, $any($event.target).value)" />
                    <button type="button" class="button-small" [disabled]="readonly"
                        (click)="setQuantity(row.id, row.quantity + 1)">+</button>
                </div>
                <button type="button" class="button-small" *ngIf="!readonly" (click)="remove(row.id)" title="Remove">
                    <clr-icon shape="times"></clr-icon>
                </button>
            </li>
        </ul>
        <vdr-product-variant-selector *ngIf="!readonly" (productSelected)="add($event.productVariantId)">
        </vdr-product-variant-selector>
    `,
    styles: [
        `
            .row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
            .thumb img { border-radius: var(--border-radius); width: 32px; height: 32px; object-fit: cover; }
            .sku { color: var(--color-grey-400); font-size: smaller; line-height: 1em; }
            .qty { display: flex; align-items: center; gap: 4px; }
            .qty-input { width: 56px; text-align: center; }
        `,
    ],
})
export class FreeProductQuantityInputComponent implements FormInputComponent, OnInit, OnDestroy {
    static readonly id = 'free-product-quantity-input';
    readonly isListInput = true;
    readonly = false;
    formControl!: FormControl;
    config: any;

    rows$!: Observable<Row[]>;
    private sub?: Subscription;

    constructor(private dataService: DataService, private cdr: ChangeDetectorRef) {}

    ngOnInit() {
        this.formControl.setValidators([
            control => (Array.isArray(control.value) && control.value.length ? null : { atLeastOne: true }),
        ]);
        this.rows$ = this.formControl.valueChanges.pipe(
            startWith(this.formControl.value),
            map(value => this.counts(value)),
            switchMap(counts => {
                const ids = [...counts.keys()];
                if (!ids.length) {
                    return of([] as Row[]);
                }
                return forkJoin(
                    ids.map(id =>
                        this.dataService.product.getProductVariant(id).mapSingle(data => data.productVariant),
                    ),
                ).pipe(
                    map(variants =>
                        ids.map((id, i) => {
                            const v: any = variants[i];
                            return {
                                id,
                                name: v?.name ?? `Variant ${id}`,
                                sku: v?.sku ?? '',
                                preview: v?.featuredAsset?.preview ?? v?.product?.featuredAsset?.preview,
                                quantity: counts.get(id) ?? 1,
                            };
                        }),
                    ),
                );
            }),
        );
    }

    ngOnDestroy() {
        this.sub?.unsubscribe();
    }

    add(id: string) {
        const counts = this.counts(this.formControl.value);
        counts.set(String(id), (counts.get(String(id)) ?? 0) + 1);
        this.write(counts);
    }

    setQuantity(id: string, raw: number | string) {
        const quantity = Math.max(1, Math.floor(Number(raw) || 1));
        const counts = this.counts(this.formControl.value);
        counts.set(id, quantity);
        this.write(counts);
    }

    remove(id: string) {
        const counts = this.counts(this.formControl.value);
        counts.delete(id);
        this.write(counts);
    }

    /** id → count, first-seen order kept. */
    private counts(value: unknown): Map<string, number> {
        const counts = new Map<string, number>();
        for (const item of Array.isArray(value) ? value : []) {
            const id = String(typeof item === 'object' && item ? (item as any).id : item);
            counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        return counts;
    }

    private write(counts: Map<string, number>) {
        const ids: string[] = [];
        counts.forEach((count, id) => {
            for (let i = 0; i < count; i++) ids.push(id);
        });
        this.formControl.setValue(ids);
        this.formControl.markAsDirty();
        this.cdr.markForCheck();
    }
}

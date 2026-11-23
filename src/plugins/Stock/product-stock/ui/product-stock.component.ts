import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import {
  CustomDetailComponent,
  DataService,
  NotificationService,
  SharedModule,
} from '@vendure/admin-ui/core';
import { Observable, Subject, BehaviorSubject, of } from 'rxjs';
import { takeUntil, switchMap, map, catchError, startWith } from 'rxjs/operators';
import { UntypedFormGroup } from '@angular/forms';
import gql from 'graphql-tag';

const GET_STOCK_LOCATIONS = gql`
  query GetStockLocations {
    stockLocations { items { id name } }
  }
`;

const GET_PRODUCT_STOCK_LEVELS = gql`
  query GetProductStockLevels($productId: ID!) {
    productStockLevels(productId: $productId) {
      id productId stockLocationId stockOnHand stockAllocated
    }
  }
`;

const SET_PRODUCT_STOCK = gql`
  mutation SetProductStock($input: SetProductStockInput!) {
    setProductStock(input: $input) { id stockOnHand }
  }
`;

const REMOVE_PRODUCT_STOCK = gql`
  mutation RemoveProductStock($productId: ID!) {
    removeProductStock(productId: $productId)
  }
`;

const RESYNC_PRODUCT_STOCK = gql`
  mutation ResyncProductStock($productId: ID!) {
    resyncProductStock(productId: $productId)
  }
`;

const GET_PRODUCT_STOCK_OVERVIEW = gql`
  query GetProductStockOverview($productId: ID!) {
    productStockOverview(productId: $productId) {
      productId stockOnHand stockAllocated availableWeight baseUnit
      variants { variantId sku name weight availableStock stockOnHand stockAllocated }
      excludedVariants { variantId sku name measure source reason }
    }
  }
`;

interface StockLocation { id: string; name: string; }
interface ProductStockLevel { id: string; productId: string; stockLocationId: string; stockOnHand: number; stockAllocated: number; }
interface VariantStockInfo { variantId: string; sku: string; name: string; weight: number; availableStock: number; stockOnHand: number; stockAllocated: number; }
interface ExcludedVariantInfo { variantId: string; sku: string; name: string; measure: string | null; source: string; reason: string; }
interface ProductStockOverview { productId: string; stockOnHand: number; stockAllocated: number; availableWeight: number; baseUnit: string; variants: VariantStockInfo[]; excludedVariants: ExcludedVariantInfo[]; }

@Component({
  selector: 'product-stock-manager',
  standalone: true,
  imports: [SharedModule],
  template: `
    <vdr-card title="Product-Level Stock">
      <div class="ps-toggle-row">
        <div class="ps-toggle-text">
          <span class="ps-toggle-title">Product-Level Stock</span>
          <span class="ps-toggle-desc">
            Track one stock pool for the whole product; variants draw from it by their measured size.
            When off, standard per-variant Vendure stock is used.
          </span>
        </div>
        <label class="ps-switch">
          <input
            type="checkbox"
            [checked]="enabled"
            (change)="toggleEnabled($any($event.target).checked)"
          />
          <span class="ps-slider"></span>
        </label>
      </div>
      <div class="ps-off-hint" *ngIf="!enabled">
        Product-level stock is off. This product uses standard per-variant Vendure stock.
        Turn it on (then click <strong>Update</strong>) to manage a shared weight pool.
      </div>
    </vdr-card>

    <ng-container *ngIf="enabled">
    <vdr-card title="Stock Levels">
      <!-- Action bar -->
      <vdr-action-bar>
        <vdr-ab-left></vdr-ab-left>
        <vdr-ab-right>
          <button
            class="btn btn-sm btn-secondary"
            *ngIf="(stockLevels$ | async)?.length === 0 && !showAddForm"
            (click)="showAddForm = true"
          >
            <clr-icon shape="plus"></clr-icon>
            Add Stock Location
          </button>
        </vdr-ab-right>
      </vdr-action-bar>

      <div *ngIf="(stockLevels$ | async) as stockLevels">
        <!-- Stock location entries -->
        <div class="stock-entries" *ngFor="let level of stockLevels">
          <div class="stock-entry-card">
            <div class="stock-entry-header">
              <div class="location-info">
                <clr-icon shape="store" size="16"></clr-icon>
                <span class="location-name">{{ getLocationName(level.stockLocationId) }}</span>
              </div>
              <div class="stock-entry-actions">
                <button
                  class="btn btn-sm btn-primary-outline btn-icon"
                  (click)="updateStock(level.stockLocationId, stockInput.value)"
                  [disabled]="saving"
                  title="Save stock"
                >
                  <clr-icon shape="check"></clr-icon>
                </button>
                <button
                  class="btn btn-sm btn-danger-outline btn-icon"
                  (click)="deleteStock()"
                  [disabled]="saving"
                  title="Remove stock"
                >
                  <clr-icon shape="trash"></clr-icon>
                </button>
              </div>
            </div>
            <div class="stock-entry-fields">
              <vdr-form-field label="Stock on Hand" [for]="'stock-' + level.stockLocationId">
                <div class="input-with-unit">
                  <input
                    [id]="'stock-' + level.stockLocationId"
                    type="number"
                    class="clr-input"
                    [value]="toDisplayUnit(level.stockOnHand)"
                    #stockInput
                    min="0"
                    [step]="inputStep"
                  />
                  <span class="unit-badge">{{ displayUnit }}</span>
                </div>
              </vdr-form-field>
              <vdr-form-field label="Allocated">
                <div class="readonly-value">
                  <span class="value-text">{{ toDisplayUnit(level.stockAllocated) }}</span>
                  <span class="unit-badge">{{ displayUnit }}</span>
                </div>
              </vdr-form-field>
            </div>
          </div>
        </div>

        <!-- Empty state -->
        <div *ngIf="stockLevels.length === 0 && !showAddForm" class="empty-state">
          <clr-icon shape="container" size="48"></clr-icon>
          <p>No product-level stock configured</p>
          <p class="empty-hint">Add a stock location to start tracking inventory at the product level.</p>
        </div>
      </div>

      <!-- Add stock location form -->
      <div class="add-stock-section" *ngIf="showAddForm && (availableLocations$ | async) as locations">
        <div class="stock-entry-card add-card">
          <div class="stock-entry-header">
            <div class="location-info">
              <clr-icon shape="plus-circle" size="16"></clr-icon>
              <span class="location-name">New Stock Location</span>
            </div>
          </div>
          <div class="add-stock-fields">
            <vdr-form-field label="Location" for="locationSelect">
              <select id="locationSelect" class="clr-select" [(ngModel)]="selectedLocationId">
                <option value="">Select a location...</option>
                <option *ngFor="let loc of locations" [value]="loc.id">{{ loc.name }}</option>
              </select>
            </vdr-form-field>
            <vdr-form-field label="Initial Stock" for="initialStock">
              <div class="input-with-unit">
                <input
                  id="initialStock"
                  type="number"
                  class="clr-input"
                  [(ngModel)]="newStockOnHand"
                  min="0"
                  placeholder="0"
                  [step]="inputStep"
                />
                <span class="unit-badge">{{ displayUnit }}</span>
              </div>
            </vdr-form-field>
          </div>
          <div class="add-stock-actions">
            <button
              class="btn btn-sm btn-primary"
              (click)="addStock()"
              [disabled]="saving || !selectedLocationId || newStockOnHand === null"
            >
              <clr-icon shape="check"></clr-icon>
              Save
            </button>
            <button class="btn btn-sm" (click)="showAddForm = false">Cancel</button>
          </div>
        </div>
      </div>
    </vdr-card>

    <!-- Stock Overview Card -->
    <vdr-card title="Stock Overview" *ngIf="(overview$ | async) as overview">
      <!-- Summary cards -->
      <div class="stock-summary-grid">
        <div class="summary-card">
          <div class="summary-icon total">
            <clr-icon shape="bundle" size="20"></clr-icon>
          </div>
          <div class="summary-detail">
            <span class="summary-label">Total Stock</span>
            <span class="summary-value">{{ toDisplayUnit(overview.stockOnHand) }} {{ displayUnit }}</span>
          </div>
        </div>
        <div class="summary-card">
          <div class="summary-icon allocated">
            <clr-icon shape="lock" size="20"></clr-icon>
          </div>
          <div class="summary-detail">
            <span class="summary-label">Allocated</span>
            <span class="summary-value">{{ toDisplayUnit(overview.stockAllocated) }} {{ displayUnit }}</span>
          </div>
        </div>
        <div class="summary-card">
          <div class="summary-icon available">
            <clr-icon shape="check-circle" size="20"></clr-icon>
          </div>
          <div class="summary-detail">
            <span class="summary-label">Available</span>
            <span class="summary-value">{{ toDisplayUnit(overview.availableWeight) }} {{ displayUnit }}</span>
          </div>
        </div>
      </div>

      <!-- Variants the pool cannot include. A variant simply missing from the
           table below reads as lost stock; it is really a unit mismatch. -->
      <div class="excluded-warning" *ngIf="overview.excludedVariants?.length">
        <clr-icon shape="exclamation-triangle" size="18"></clr-icon>
        <div class="excluded-body">
          <div class="excluded-title">
            {{ overview.excludedVariants.length }}
            {{ overview.excludedVariants.length === 1 ? 'variant is' : 'variants are' }}
            not drawing from this pool
          </div>
          <p class="excluded-help">
            This pool counts {{ displayUnit }}. A variant measured in another unit cannot be added to
            it, and one with no measurement has nothing to divide by &mdash; either way it is left out
            and shows no pool stock. Set Measure Value and Measure Unit on the option
            (Catalog &rsaquo; Option Groups).
          </p>
          <ul class="excluded-list">
            <li *ngFor="let ex of overview.excludedVariants">
              <span class="excluded-name">{{ ex.name }}</span>
              <vdr-chip>
                {{ ex.reason === 'NO_MEASUREMENT'
                    ? 'no measurement'
                    : ex.measure + ' \u00b7 from its option' }}
              </vdr-chip>
            </li>
          </ul>
        </div>
      </div>

      <!-- Variant breakdown table -->
      <div class="variant-section" *ngIf="overview.variants.length > 0">
        <h4 class="section-title">Variant Breakdown</h4>
        <table class="table variant-table">
          <thead>
            <tr>
              <th class="left">Variant</th>
              <th>Weight</th>
              <th>Available</th>
              <th>Allocated</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let v of overview.variants">
              <td class="left">
                <span class="variant-name">{{ v.name }}</span>
              </td>
              <td>
                <vdr-chip>{{ toDisplayUnit(v.weight) }} {{ displayUnit }}</vdr-chip>
              </td>
              <td>
                <span class="stock-available" [class.low-stock]="v.availableStock <= 10" [class.out-of-stock]="v.availableStock === 0">
                  {{ v.availableStock }}
                </span>
              </td>
              <td>{{ v.stockAllocated }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Resync action -->
      <div class="resync-section">
        <button
          class="btn btn-sm btn-secondary"
          (click)="resyncStock()"
          [disabled]="saving"
        >
          <clr-icon shape="refresh"></clr-icon>
          Re-sync Variant Stock
        </button>
      </div>
    </vdr-card>
    </ng-container>
  `,
  styles: [`
    /* Product-level stock toggle */
    .ps-toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .ps-toggle-text {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
    }
    .ps-toggle-title {
      font-weight: 600;
      font-size: 0.9rem;
      color: var(--color-text-100);
    }
    .ps-toggle-desc {
      font-size: 0.78rem;
      color: var(--color-text-300);
      max-width: 46ch;
    }
    .ps-switch {
      position: relative;
      width: 44px;
      height: 24px;
      flex-shrink: 0;
      cursor: pointer;
    }
    .ps-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .ps-slider {
      position: absolute;
      inset: 0;
      background: #cbd5e1;
      border-radius: 24px;
      transition: 0.3s;
    }
    .ps-slider:before {
      content: "";
      position: absolute;
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background: white;
      border-radius: 50%;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
      transition: 0.3s;
    }
    .ps-switch input:checked + .ps-slider {
      background: var(--color-success-500, #2eb85c);
    }
    .ps-switch input:checked + .ps-slider:before {
      transform: translateX(20px);
    }
    .ps-off-hint {
      margin-top: 0.75rem;
      font-size: 0.8rem;
      color: var(--color-text-300);
    }

    /* Action bar overrides */
    :host ::ng-deep vdr-action-bar {
      margin-bottom: 0.75rem;
    }

    /* Stock entry card */
    .stock-entry-card {
      background: var(--color-component-bg-200);
      border: 1px solid var(--color-component-border-200);
      border-radius: 6px;
      padding: 1rem;
      margin-bottom: 0.75rem;
    }
    .stock-entry-card.add-card {
      border-style: dashed;
      border-color: var(--color-primary-400);
      background: var(--color-component-bg-100);
    }
    .stock-entry-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.75rem;
    }
    .location-info {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .location-info clr-icon {
      color: var(--color-primary-500);
    }
    .location-name {
      font-weight: 600;
      font-size: 0.875rem;
      color: var(--color-text-100);
    }
    .stock-entry-actions {
      display: flex;
      gap: 0.25rem;
    }
    .btn-icon {
      padding: 0.25rem 0.5rem;
      min-width: unset;
    }

    /* Stock fields layout */
    .stock-entry-fields {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }
    .add-stock-fields {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      margin-bottom: 0.75rem;
    }
    .add-stock-actions {
      display: flex;
      gap: 0.5rem;
      justify-content: flex-end;
    }

    /* Input with unit badge */
    .input-with-unit {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .input-with-unit .clr-input {
      flex: 1;
    }
    .unit-badge {
      display: inline-flex;
      align-items: center;
      padding: 0.15rem 0.5rem;
      border-radius: 3px;
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      background: var(--color-component-bg-300, #e8e8e8);
      color: var(--color-text-200);
      white-space: nowrap;
    }

    /* Readonly value display */
    .readonly-value {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.375rem 0;
    }
    .value-text {
      font-size: 0.95rem;
      font-weight: 500;
      color: var(--color-text-100);
    }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 2rem 1rem;
      color: var(--color-text-300);
    }
    .empty-state clr-icon {
      color: var(--color-text-300);
      opacity: 0.5;
    }
    .empty-state p {
      margin: 0.5rem 0 0;
      font-size: 0.875rem;
    }
    .empty-hint {
      font-size: 0.75rem !important;
      color: var(--color-text-300);
    }

    /* Stock summary grid */
    .stock-summary-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.75rem;
      margin-bottom: 1.25rem;
    }
    .summary-card {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      border-radius: 6px;
      background: var(--color-component-bg-200);
      border: 1px solid var(--color-component-border-200);
    }
    .summary-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border-radius: 8px;
      flex-shrink: 0;
    }
    .summary-icon.total {
      background: var(--color-primary-100, rgba(49, 120, 198, 0.1));
      color: var(--color-primary-500);
    }
    .summary-icon.allocated {
      background: var(--color-warning-100, rgba(255, 193, 7, 0.1));
      color: var(--color-warning-500, #e6a817);
    }
    .summary-icon.available {
      background: var(--color-success-100, rgba(46, 184, 92, 0.1));
      color: var(--color-success-500, #2eb85c);
    }
    .summary-detail {
      display: flex;
      flex-direction: column;
    }
    .summary-label {
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--color-text-300);
      letter-spacing: 0.03em;
    }
    .summary-value {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--color-text-100);
    }

    /* Variant section */
    .section-title {
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--color-text-300);
      letter-spacing: 0.03em;
      margin: 0 0 0.5rem 0;
    }
    .variant-table {
      width: 100%;
      margin: 0;
    }
    .variant-table th {
      font-size: 0.7rem;
      text-transform: uppercase;
      color: var(--color-text-300);
      font-weight: 600;
      padding: 0.5rem 0.75rem;
      text-align: center;
      border-bottom: 2px solid var(--color-component-border-200);
    }
    .variant-table th.left {
      text-align: left;
    }
    .variant-table td {
      padding: 0.5rem 0.75rem;
      font-size: 0.85rem;
      text-align: center;
      vertical-align: middle;
      border-bottom: 1px solid var(--color-component-border-100);
    }
    .variant-table td.left {
      text-align: left;
    }
    .variant-name {
      font-weight: 500;
      color: var(--color-text-100);
    }
    .stock-available {
      font-weight: 700;
      color: var(--color-success-500, #2eb85c);
    }
    .stock-available.low-stock {
      color: var(--color-warning-500, #e6a817);
    }
    .stock-available.out-of-stock {
      color: var(--color-error-500, #e34c26);
    }

    /* Resync section */
    .resync-section {
      margin-top: 1rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--color-component-border-200);
    }

    /* Add stock section */
    .add-stock-section {
      margin-top: 0.5rem;
    }

    /* Excluded-variant warning */
    .excluded-warning {
      display: flex;
      gap: 0.75rem;
      align-items: flex-start;
      margin-top: 1rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--color-warning-300, #e8bb6a);
      border-radius: 4px;
      background: var(--color-warning-100, rgba(232, 187, 106, 0.12));
    }
    .excluded-warning clr-icon {
      flex-shrink: 0;
      margin-top: 0.125rem;
    }
    .excluded-body {
      display: flex;
      flex-direction: column;
      gap: 0.375rem;
    }
    .excluded-title {
      font-weight: 600;
    }
    .excluded-help {
      margin: 0;
      font-size: 0.75rem;
      opacity: 0.85;
    }
    .excluded-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      font-size: 0.75rem;
    }
    .excluded-list li {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
    }
    .excluded-name {
      font-weight: 500;
    }

    /* Responsive adjustments */
    @media (max-width: 768px) {
      .stock-summary-grid {
        grid-template-columns: 1fr;
      }
      .stock-entry-fields,
      .add-stock-fields {
        grid-template-columns: 1fr;
      }
    }
  `]
})
export class ProductStockComponent implements CustomDetailComponent, OnInit, OnDestroy {
  entity$!: Observable<any>;
  detailForm!: UntypedFormGroup;

  stockLocations: StockLocation[] = [];
  stockLevels$!: Observable<ProductStockLevel[]>;
  overview$!: Observable<ProductStockOverview | null>;
  availableLocations$!: Observable<StockLocation[]>;

  /**
   * What the pool integer counts, straight from the server.
   *
   * Was a hard-coded 'kg'. That was true while every pool was a weight pool and
   * silently wrong the moment one was authored in litres or pieces -- the card
   * labelled 6000 ml as "6 kg". Defaults to 'g' to match the server's own
   * default for an unmeasured product.
   */
  poolBaseUnit: 'g' | 'ml' | 'piece' = 'g';
  selectedLocationId = '';
  newStockOnHand: number | null = 0;
  saving = false;
  showAddForm = false;

  private productId!: string;
  private refresh$ = new BehaviorSubject<void>(undefined);
  private destroy$ = new Subject<void>();

  constructor(
    private dataService: DataService,
    private notificationService: NotificationService,
    private cdRef: ChangeDetectorRef,
  ) {}

  get enabled(): boolean {
    return !!this.detailForm?.get('customFields.productStockEnabled')?.value;
  }

  toggleEnabled(next: boolean) {
    const control = this.detailForm?.get('customFields.productStockEnabled');
    if (!control) return;
    control.setValue(next);
    control.markAsDirty();
    control.markAsTouched();
    this.cdRef.markForCheck();
  }

  ngOnInit() {
    this.loadStockLocations();

    const productData$ = this.entity$.pipe(
      switchMap(product => this.refresh$.pipe(map(() => product))),
    );

    this.stockLevels$ = productData$.pipe(
      switchMap(product => {
        if (!product?.id) return of([]);
        this.productId = product.id;
        return this.dataService
          .query(GET_PRODUCT_STOCK_LEVELS, { productId: product.id })
          .mapSingle((data: any) => data.productStockLevels || []);
      }),
      catchError(() => of([])),
      takeUntil(this.destroy$),
    );

    this.overview$ = productData$.pipe(
      switchMap(product => {
        if (!product?.id) return of(null);
        return this.dataService
          .query(GET_PRODUCT_STOCK_OVERVIEW, { productId: product.id })
          .mapSingle((data: any) => {
            const overview: ProductStockOverview | null = data.productStockOverview || null;
            // The Stock Levels card renders from its own stream, so the unit has
            // to live on the component rather than inside this card's template.
            if (overview?.baseUnit) {
              this.poolBaseUnit = overview.baseUnit as 'g' | 'ml' | 'piece';
              this.cdRef.markForCheck();
            }
            return overview;
          });
      }),
      catchError(() => of(null)),
      takeUntil(this.destroy$),
    );

    this.availableLocations$ = this.stockLevels$.pipe(
      map((levels: ProductStockLevel[]) => {
        const usedIds = new Set(levels.map(l => String(l.stockLocationId)));
        return this.stockLocations.filter(loc => !usedIds.has(String(loc.id)));
      }),
      startWith(this.stockLocations),
    );
  }

  loadStockLocations() {
    this.dataService
      .query(GET_STOCK_LOCATIONS)
      .mapSingle((data: any) => data.stockLocations?.items || [])
      .pipe(takeUntil(this.destroy$))
      .subscribe((locations: StockLocation[]) => {
        this.stockLocations = locations;
        this.cdRef.markForCheck();
      });
  }

  /**
   * Suffix shown beside every pool figure: 'kg', 'L' or 'pcs'.
   *
   * A getter, not a field, so all seven existing template bindings keep working
   * unchanged while the value now follows the data.
   */
  get displayUnit(): string {
    if (this.poolBaseUnit === 'g') return 'kg';
    if (this.poolBaseUnit === 'ml') return 'L';
    return 'pcs';
  }

  /** Counted pools move in whole units; measured pools accept fractions. */
  get inputStep(): string {
    return this.poolBaseUnit === 'piece' ? '1' : '0.001';
  }

  /**
   * Scale factor between the stored base integer and what a human types.
   *
   * NOTE: a deliberate mirror of STOCK_UNITS in
   * src/plugins/Stock/shared/stock-units.ts, NOT a second source of truth. The
   * Angular extension is compiled by ui-devkit, which copies only this `ui`
   * folder into the admin build, so a relative import reaching up into
   * ../../shared would not resolve -- no file in any plugin's ui/ folder
   * imports outside it. The Dashboard block, compiled by vite, imports the
   * shared module directly. Keep the two in step: g and ml scale by 1000,
   * counted units do not scale.
   */
  private get unitFactor(): number {
    return this.poolBaseUnit === 'piece' ? 1 : 1000;
  }

  /** Stored base integer (g / ml / piece) -> the figure an operator reads. */
  toDisplayUnit(baseValue: number): number {
    const factor = this.unitFactor;
    return factor === 1 ? baseValue : +(baseValue / factor).toFixed(3);
  }

  /** The figure an operator typed -> the base integer the pool stores. */
  toPoolBase(value: number): number {
    return Math.round(value * this.unitFactor);
  }

  getLocationName(stockLocationId: string): string {
    return this.stockLocations.find(l => String(l.id) === String(stockLocationId))?.name || `Location #${stockLocationId}`;
  }

  addStock() {
    if (!this.selectedLocationId || this.newStockOnHand === null || !this.productId) return;
    this.saving = true;
    this.dataService
      .mutate(SET_PRODUCT_STOCK, { input: { productId: this.productId, stockLocationId: this.selectedLocationId, stockOnHand: this.toPoolBase(Number(this.newStockOnHand)) } })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.notificationService.success('Product stock set successfully');
          this.selectedLocationId = '';
          this.newStockOnHand = 0;
          this.saving = false;
          this.showAddForm = false;
          this.refresh$.next();
          this.cdRef.markForCheck();
        },
        error: (err: any) => {
          this.notificationService.error('Failed: ' + (err.message || 'Unknown error'));
          this.saving = false;
          this.cdRef.markForCheck();
        },
      });
  }

  deleteStock() {
    if (!this.productId) return;
    this.saving = true;
    this.dataService
      .mutate(REMOVE_PRODUCT_STOCK, { productId: this.productId })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.notificationService.success('Product stock removed');
          this.saving = false;
          this.refresh$.next();
          this.cdRef.markForCheck();
        },
        error: (err: any) => {
          this.notificationService.error('Failed: ' + (err.message || 'Unknown error'));
          this.saving = false;
          this.cdRef.markForCheck();
        },
      });
  }

  updateStock(stockLocationId: string, stockOnHandValue: string) {
    if (!this.productId) return;
    this.saving = true;
    this.dataService
      .mutate(SET_PRODUCT_STOCK, { input: { productId: this.productId, stockLocationId, stockOnHand: this.toPoolBase(Number(stockOnHandValue)) } })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.notificationService.success('Product stock updated');
          this.saving = false;
          this.refresh$.next();
          this.cdRef.markForCheck();
        },
        error: (err: any) => {
          this.notificationService.error('Failed: ' + (err.message || 'Unknown error'));
          this.saving = false;
          this.cdRef.markForCheck();
        },
      });
  }

  resyncStock() {
    if (!this.productId) return;
    this.saving = true;
    this.dataService
      .mutate(RESYNC_PRODUCT_STOCK, { productId: this.productId })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: () => {
          this.notificationService.success('Variant stock levels re-synced');
          this.saving = false;
          this.refresh$.next();
          this.cdRef.markForCheck();
        },
        error: (err: any) => {
          this.notificationService.error('Re-sync failed: ' + (err.message || 'Unknown error'));
          this.saving = false;
          this.cdRef.markForCheck();
        },
      });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }
}

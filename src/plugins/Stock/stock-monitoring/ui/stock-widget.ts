import { Component, NgModule, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import {
  DataService,
  SharedModule,
  ProductVariant, // Corrected import
} from '@vendure/admin-ui/core';
import { Observable, BehaviorSubject, combineLatest, interval } from 'rxjs';
import { map, switchMap, catchError, distinctUntilChanged, takeUntil, startWith } from 'rxjs/operators';
import { Subject, of } from 'rxjs';
import gql from 'graphql-tag';

@Component({
  standalone: true,
  imports: [SharedModule],
  selector: 'stock-widget',
  template: `
    <!-- Permission Denied Message -->
    <div *ngIf="!hasPermission" style="text-align: center; padding: 2rem; background-color: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; margin: 1rem auto;">
      <p style="color: #856404; margin: 0;">You don't have permission to view stock monitoring. Please contact your administrator.</p>
    </div>

    <!-- Stock Data Table - Only visible with permission -->
    <vdr-data-table
      *ngIf="hasPermission"
      [items]="variant$ | async"
      [itemsPerPage]="itemsPerPage"
      [totalItems]="totalItems$ | async"
      [currentPage]="currentPage$ | async"
      (pageChange)="onPageChange($event)"
      (itemsPerPageChange)="onItemsPerPageChange($event)"
      class="stock-widget-overflow"
    >
      <ng-template let-variant="item">
        <td
          class="left align-middle"
          [ngClass]="getStockRowClass(variant.stockLevels)"
        >
          <a [routerLink]="['/catalog', 'products', variant.productId, 'variants', variant.id]">{{
            variant.name
          }}</a>
        </td>
        <td
          class="left align-middle"
          [ngClass]="getStockRowClass(variant.stockLevels)"
        >
          <span
            class="stock-badge"
            [ngClass]="getStockBadgeClass(variant.stockLevels)"
          >
            {{ reduceSum(variant.stockLevels) }}
          </span>
        </td>
      </ng-template>
    </vdr-data-table>
  `,
  styles: [
    '.stock-widget-overflow { max-height: 300px; overflow: scroll; }',
    '.stock-row-low { background-color: rgba(255, 152, 0, 0.12); }',
    '.stock-row-critical { background-color: rgba(198, 40, 40, 0.2); }',
    '.stock-badge { display: inline-block; padding: 4px 12px; border-radius: 999px; font-weight: 600; min-width: 48px; text-align: center; color: #0d1117; background-color: #ff9800; }',
    '.stock-badge.stock-critical { background-color: #c62828; color: #ffffff; box-shadow: 0 0 0 1px rgba(0,0,0,0.1); }',
    '.stock-badge.stock-low { background-color: #ff9800; color: #0d1117; }',
  ],
})
export class StockWidgetComponent implements OnInit, OnDestroy {
  variant$: Observable<ProductVariant[]>;
  totalItems$: Observable<number>;
  currentPage$ = new BehaviorSubject<number>(1);
  itemsPerPage = 10;

  private pagination$ = new BehaviorSubject<{ skip: number; take: number }>({
    skip: 0,
    take: 10,
  });

  private destroy$ = new Subject<void>();
  private channelId$ = new BehaviorSubject<string | null>(null);
  hasPermission = false;
  requiredPermission: string | null = 'ReadCatalog'; // Default permission, can be configured via plugin options

  constructor(
    private dataService: DataService,
    private cdRef: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.checkPermissions();
    this.watchActiveChannel();
    this.loadStockData();
  }

  checkPermissions() {
    // If no permission required, allow all authenticated users
    if (!this.requiredPermission) {
      this.hasPermission = true;
      this.cdRef.detectChanges();
      return;
    }

    this.dataService
      .query<{ me: { channels: Array<{ permissions: string[] }> } }>(
        gql`
          query GetCurrentUserPermissions {
            me {
              channels {
                permissions
              }
            }
          }
        `
      )
      .single$.subscribe({
        next: (response) => {
          const permissions = response.me.channels?.[0]?.permissions || [];
          // Check if user has required permission or SuperAdmin
          // requiredPermission is guaranteed to be non-null here due to early return above
          this.hasPermission = 
            (this.requiredPermission && permissions.includes(this.requiredPermission)) || 
            permissions.includes('SuperAdmin');
          this.cdRef.detectChanges();
          
          // Only load stock data if user has permission
          if (!this.hasPermission) {
            this.variant$ = of([]);
            this.totalItems$ = of(0);
          }
        },
        error: (err) => {
          console.error('Failed to fetch user permissions', err);
          this.hasPermission = false;
          this.cdRef.detectChanges();
        },
      });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  watchActiveChannel() {
    // Poll for active channel changes every 2 seconds
    // interval(2000)
    this.dataService.client
      .userStatus()
      .mapStream(data => data.userStatus.activeChannelId)
      .pipe(
          distinctUntilChanged(),
          takeUntil(this.destroy$)
      )
      .subscribe(channelId => {
          if (channelId) {
             this.channelId$.next(channelId);
          }
      });
  }

  loadStockData() {
    // Combine channel changes with pagination changes
    const query$ = combineLatest([this.channelId$, this.pagination$]).pipe(
      switchMap(([channelId, { skip, take }]) => {
        if (!channelId) {
          return of({ items: [], totalItems: 0 });
        }
        
        return this.dataService
          .query(
            gql`
              query productVariantsWithLowStock($skip: Int, $take: Int) {
                productVariantsWithLowStock(skip: $skip, take: $take) {
                  items {
                    id
                    name
                    enabled
                    productId
                    stockLevels {
                      stockOnHand
                    }
                  }
                  totalItems
                }
              }
            `,
            { skip, take }
          )
          .mapStream((data) => (data as any).productVariantsWithLowStock);
      }),
      catchError((error) => {
        console.error('Error loading stock data:', error);
        return of({ items: [], totalItems: 0 });
      })
    );

    this.variant$ = query$.pipe(map((result) => result.items || []));
    this.totalItems$ = query$.pipe(map((result) => result.totalItems || 0));
  }

  onPageChange(page: number) {
    this.currentPage$.next(page);
    const skip = (page - 1) * this.itemsPerPage;
    this.pagination$.next({ skip, take: this.itemsPerPage });
  }

  onItemsPerPageChange(itemsPerPage: number) {
    this.itemsPerPage = itemsPerPage;
    this.currentPage$.next(1);
    this.pagination$.next({ skip: 0, take: itemsPerPage });
  }

  reduceSum(stockLevels: Array<{ stockOnHand: number }>): number {
    if (!stockLevels) {
      return 0;
    }
    return stockLevels.reduce((acc, val) => (acc += val.stockOnHand), 0);
  }

  getStockBadgeClass(stockLevels: Array<{ stockOnHand: number }>): string {
    const total = this.reduceSum(stockLevels);
    return total < 10 ? 'stock-critical' : 'stock-low';
  }

  getStockRowClass(stockLevels: Array<{ stockOnHand: number }>): string {
    const total = this.reduceSum(stockLevels);
    return total < 10 ? 'stock-row-critical' : 'stock-row-low';
  }
}
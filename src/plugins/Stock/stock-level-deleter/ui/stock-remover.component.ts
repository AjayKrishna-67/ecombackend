import { Component, OnInit, OnDestroy, Injector, ChangeDetectorRef } from '@angular/core';
import { CustomDetailComponent, DataService, NotificationService, SharedModule, ModalService } from '@vendure/admin-ui/core';
import { Observable, Subject, of, EMPTY, BehaviorSubject } from 'rxjs';
import { takeUntil, switchMap, map } from 'rxjs/operators';
import { UntypedFormGroup } from '@angular/forms';
import gql from 'graphql-tag';
import { DeleteConfirmationDialogComponent } from './delete-confirmation-dialog.component';

const DELETE_STOCK_LEVEL = gql`
  mutation DeleteStockLevel($productVariantId: ID!, $stockLocationId: ID!) {
    deleteStockLevel(productVariantId: $productVariantId, stockLocationId: $stockLocationId)
  }
`;

@Component({
  selector: 'stock-remover',
  standalone: true,
  imports: [SharedModule],
  template: `
    <vdr-card title="Manage Stock Locations">
      <div class="stock-list" *ngIf="(filteredStockLevels$ | async) as stockLevels">
        <div class="stock-row" *ngFor="let level of stockLevels">
          <div class="stock-info">
            <span class="location-name">{{ level.stockLocation?.name || 'Unknown Location' }}</span>
            <span class="stock-amount">Stock: {{ level.stockOnHand || 0 }}</span>
            <span class="allocated" *ngIf="level.stockAllocated > 0">
              Allocated: {{ level.stockAllocated }}
            </span>
          </div>
          <button 
            class="btn btn-danger btn-sm" 
            (click)="deleteLevel(level.stockLocation?.id, level.stockLocation?.name)"
            [disabled]="deleting"
          >
            <clr-icon shape="trash"></clr-icon>
            Delete
          </button>
        </div>
        <div class="no-stock" *ngIf="!stockLevels || stockLevels.length === 0">
          <p>No stock locations configured for this variant.</p>
        </div>
      </div>
    </vdr-card>
  `,
  styles: [`
    .stock-list {
      padding: 0.5rem 0;
    }

    .stock-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem;
      margin-bottom: 0.5rem;
      border: 1px solid var(--color-component-border-300);
      border-radius: 4px;
      background: var(--color-component-bg-100);
    }

    .stock-row:last-child {
      margin-bottom: 0;
    }

    .stock-info {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      flex: 1;
    }

    .location-name {
      font-weight: 600;
      color: var(--color-text-100);
      font-size: 0.875rem;
    }

    .stock-amount {
      font-size: 0.8125rem;
      color: var(--color-text-300);
    }

    .allocated {
      font-size: 0.75rem;
      color: var(--color-warning-500);
    }

    .btn-danger {
      margin-left: 1rem;
    }

    .no-stock {
      padding: 1rem;
      text-align: center;
      color: var(--color-text-300);
      font-style: italic;
    }
  `]
})
export class StockRemoverComponent implements CustomDetailComponent, OnInit, OnDestroy {
  entity$: Observable<any>;
  detailForm: UntypedFormGroup;
  deleting = false;
  filteredStockLevels$: Observable<any[]>;
  private deletedLocationIds = new Set<string>();
  private destroy$ = new Subject<void>();
  private modalService: ModalService;

  constructor(
    private dataService: DataService,
    private notificationService: NotificationService,
    private injector: Injector,
    private cdRef: ChangeDetectorRef
  ) {
    // Get ModalService from injector (required for CustomDetailComponent)
    this.modalService = this.injector.get(ModalService);
  }

  ngOnInit() {
    // Filter out deleted stock levels from the entity$ observable
    this.filteredStockLevels$ = this.entity$.pipe(
      map((variant: any) => {
        if (!variant?.stockLevels) {
          return [];
        }
        // Filter out any stock levels that have been deleted
        return variant.stockLevels.filter((level: any) => 
          !this.deletedLocationIds.has(level.stockLocation?.id)
        );
      }),
      takeUntil(this.destroy$)
    );
  }

  deleteLevel(locationId: string, locationName: string) {
    if (!locationId) {
      this.notificationService.error('Invalid stock location ID');
      return;
    }

    // Show Vendure modal confirmation dialog
    this.modalService
      .fromComponent(DeleteConfirmationDialogComponent, {
        size: 'md',
        closable: true,
        locals: {
          locationName: locationName || 'Unknown Location'
        }
      })
      .pipe(
        switchMap(confirmed => {
          if (!confirmed) {
            // User cancelled
            return EMPTY;
          }

          // User confirmed, proceed with deletion
          this.deleting = true;
          return this.entity$.pipe(
            takeUntil(this.destroy$),
            switchMap(variant => {
              if (!variant?.id) {
                this.notificationService.error('Product variant not found');
                this.deleting = false;
                return EMPTY;
              }

              return this.dataService.mutate(DELETE_STOCK_LEVEL, {
                productVariantId: variant.id,
                stockLocationId: locationId
              });
            })
          );
        }),
        takeUntil(this.destroy$)
      )
      .subscribe({
        next: () => {
          // Mark this location as deleted so it's filtered out
          this.deletedLocationIds.add(locationId);
          this.notificationService.success('Stock location removed successfully');
          this.deleting = false;
          // Trigger change detection to update the UI
          this.cdRef.markForCheck();
        },
        error: (err) => {
          this.notificationService.error('Failed to remove stock location: ' + (err.message || 'Unknown error'));
          this.deleting = false;
        }
      });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }
}


import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { DataService, SharedModule } from '@vendure/admin-ui/core';
import { Observable, BehaviorSubject, combineLatest, Subject, of } from 'rxjs';
import { map, switchMap, catchError, distinctUntilChanged, takeUntil } from 'rxjs/operators';
import gql from 'graphql-tag';

interface CustomerDeletionRequest {
    id: string;
    firstName: string;
    lastName: string;
    phoneNumber: string;
    emailAddress: string;
    reason: string;
    requestedDate: string;
}

@Component({
    standalone: true,
    imports: [SharedModule],
    selector: 'customer-deletion-widget',
    template: `
        <div *ngIf="!hasPermission" style="text-align: center; padding: 2rem; background-color: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; margin: 1rem auto;">
            <p style="color: #856404; margin: 0;">You don't have permission to view deletion requests.</p>
        </div>
        <vdr-data-table
            *ngIf="hasPermission"
            [items]="items$ | async"
            [itemsPerPage]="itemsPerPage"
            [totalItems]="totalItems$ | async"
            [currentPage]="currentPage$ | async"
            (pageChange)="onPageChange($event)"
            (itemsPerPageChange)="onItemsPerPageChange($event)"
            class="deletion-widget-overflow"
        >
            <ng-template let-item="item">
                <td class="left align-middle">
                    <a [routerLink]="['/customer', 'customers', item.id]">
                        {{ item.emailAddress }}
                    </a>
                </td>
                <td class="left align-middle">
                    {{ item.phoneNumber }}
                </td>
                <td class="left align-middle">
                    {{ item.reason || '-' }}
                </td>
                <td class="left align-middle">
                    {{ formatDate(item.requestedDate) }}
                </td>
            </ng-template>
        </vdr-data-table>
    `,
    styles: [
        '.deletion-widget-overflow { max-height: 300px; overflow: scroll; }',
    ],
})
export class CustomerDeletionWidgetComponent implements OnInit, OnDestroy {
    items$: Observable<CustomerDeletionRequest[]>;
    totalItems$: Observable<number>;
    currentPage$ = new BehaviorSubject<number>(1);
    itemsPerPage = 10;
    hasPermission = false;

    private pagination$ = new BehaviorSubject<{ skip: number; take: number }>({ skip: 0, take: 10 });
    private destroy$ = new Subject<void>();
    private channelId$ = new BehaviorSubject<string | null>(null);

    constructor(
        private dataService: DataService,
        private cdRef: ChangeDetectorRef,
    ) {}

    ngOnInit() {
        this.checkPermissions();
        this.watchActiveChannel();
        this.loadData();
    }

    ngOnDestroy() {
        this.destroy$.next();
        this.destroy$.complete();
    }

    checkPermissions() {
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
                `,
            )
            .single$.subscribe({
                next: (response) => {
                    const permissions = response.me.channels?.[0]?.permissions || [];
                    this.hasPermission =
                        permissions.includes('ReadCustomer') || permissions.includes('SuperAdmin');
                    this.cdRef.detectChanges();
                    if (!this.hasPermission) {
                        this.items$ = of([]);
                        this.totalItems$ = of(0);
                    }
                },
                error: () => {
                    this.hasPermission = false;
                    this.cdRef.detectChanges();
                },
            });
    }

    watchActiveChannel() {
        this.dataService.client
            .userStatus()
            .mapStream((data) => data.userStatus.activeChannelId)
            .pipe(distinctUntilChanged(), takeUntil(this.destroy$))
            .subscribe((channelId) => {
                if (channelId) {
                    this.channelId$.next(channelId);
                }
            });
    }

    loadData() {
        const query$ = combineLatest([this.channelId$, this.pagination$]).pipe(
            switchMap(([channelId, { skip, take }]) => {
                if (!channelId) {
                    return of({ items: [], totalItems: 0 });
                }
                return this.dataService
                    .query(
                        gql`
                            query CustomersWithDeletionRequest($skip: Int, $take: Int) {
                                customersWithDeletionRequest(skip: $skip, take: $take) {
                                    items {
                                        id
                                        firstName
                                        lastName
                                        phoneNumber
                                        emailAddress
                                        reason
                                        requestedDate
                                    }
                                    totalItems
                                }
                            }
                        `,
                        { skip, take },
                    )
                    .mapStream((data) => (data as any).customersWithDeletionRequest);
            }),
            catchError(() => of({ items: [], totalItems: 0 })),
        );
        this.items$ = query$.pipe(map((result) => result.items || []));
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

    formatDate(dateStr: string): string {
        if (!dateStr) return '-';
        return new Date(dateStr).toLocaleDateString('en-IN', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    }
}

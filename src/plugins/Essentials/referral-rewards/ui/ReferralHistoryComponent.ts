import { Component, OnInit } from '@angular/core';
import { DataService, NotificationService, SharedModule } from '@vendure/admin-ui/core';
import gql from 'graphql-tag';

interface Referral {
    id: string;
    createdAt: string;
    referrer: { id: string; firstName: string; lastName: string };
    referredCustomer: { id: string; firstName: string; lastName: string };
    status: string;
    points: number;
    isScratched: boolean;
    order: { id: string; code: string } | null;
}

interface ReferralListResponse {
    referrals: { items: Referral[]; totalItems: number };
}

const GET_REFERRALS = gql`
    query GetReferrals($take: Int, $skip: Int) {
        referrals(take: $take, skip: $skip) {
            items {
                id
                createdAt
                referrer {
                    id
                    firstName
                    lastName
                }
                referredCustomer {
                    id
                    firstName
                    lastName
                }
                status
                points
                isScratched
                order {
                    id
                    code
                }
            }
            totalItems
        }
    }
`;

@Component({
    selector: 'referral-history',
    template: `
        <vdr-page-block>
            <vdr-card>
                <div *ngIf="referrals.length === 0" class="empty-state">
                    <clr-icon shape="share" size="48"></clr-icon>
                    <p>No referrals found for this channel.</p>
                </div>

                <table class="table" *ngIf="referrals.length > 0">
                    <thead>
                        <tr>
                            <th>Referrer</th>
                            <th>Referred Customer</th>
                            <th>Status</th>
                            <th>Points</th>
                            <th>Date</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr *ngFor="let referral of referrals">
                            <td>
                                <a [routerLink]="['/customer/customers', referral.referrer.id]">
                                    {{ referral.referrer.firstName }} {{ referral.referrer.lastName }}
                                </a>
                            </td>
                            <td>
                                <a [routerLink]="['/customer/customers', referral.referredCustomer.id]">
                                    {{ referral.referredCustomer.firstName }} {{ referral.referredCustomer.lastName }}
                                </a>
                            </td>
                            <td>
                                <span class="status-badge" [ngClass]="'status-' + referral.status.toLowerCase()">
                                    {{ referral.status }}
                                </span>
                            </td>
                            <td>{{ referral.points }}</td>
                            <td>{{ referral.createdAt | date:'medium' }}</td>
                        </tr>
                    </tbody>
                </table>

                <div *ngIf="totalItems > 0" class="pagination-bar">
                    <div class="page-size">
                        <span>Items per page:</span>
                        <select (change)="onItemsPerPageChange($event)">
                            <option *ngFor="let size of pageSizes" [value]="size" [selected]="size === itemsPerPage">
                                {{ size }}
                            </option>
                        </select>
                    </div>
                    <div class="page-info">
                        {{ startIndex + 1 }} - {{ endIndex }} of {{ totalItems }}
                    </div>
                    <div class="page-nav">
                        <button class="btn btn-sm btn-icon" [disabled]="currentPage === 1" (click)="goToPage(1)" title="First">
                            <clr-icon shape="step-forward-2" dir="down" style="transform: rotate(180deg)"></clr-icon>
                        </button>
                        <button class="btn btn-sm btn-icon" [disabled]="currentPage === 1" (click)="goToPage(currentPage - 1)" title="Previous">
                            <clr-icon shape="angle" dir="left"></clr-icon>
                        </button>
                        <span class="page-number">Page {{ currentPage }} of {{ totalPages }}</span>
                        <button class="btn btn-sm btn-icon" [disabled]="currentPage === totalPages" (click)="goToPage(currentPage + 1)" title="Next">
                            <clr-icon shape="angle" dir="right"></clr-icon>
                        </button>
                        <button class="btn btn-sm btn-icon" [disabled]="currentPage === totalPages" (click)="goToPage(totalPages)" title="Last">
                            <clr-icon shape="step-forward-2"></clr-icon>
                        </button>
                    </div>
                </div>
            </vdr-card>
        </vdr-page-block>
    `,
    styles: [`
        .page-title {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .page-title h2 {
            margin: 0;
        }
        .badge {
            background: var(--color-primary-500);
            color: white;
            padding: 2px 10px;
            border-radius: 12px;
            font-size: 13px;
        }
        .table {
            width: 100%;
            border-collapse: collapse;
        }
        .table th,
        .table td {
            padding: 10px 12px;
            text-align: left;
            border-bottom: 1px solid var(--color-component-border-200);
        }
        .table th {
            font-weight: 600;
            color: var(--color-text-300);
            font-size: 13px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .table tbody tr:hover {
            background: var(--color-component-bg-100);
        }
        .status-badge {
            padding: 3px 10px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
        }
        .status-registered { background: #fff3cd; color: #856404; }
        .status-eligible { background: #cce5ff; color: #004085; }
        .status-claimed { background: #d4edda; color: #155724; }
        .empty-state {
            padding: 3rem;
            text-align: center;
            color: var(--color-text-300);
        }
        .pagination-bar {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 1.5rem;
            padding: 12px 0 0;
            margin-top: 12px;
            border-top: 1px solid var(--color-component-border-200);
        }
        .page-size {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            color: var(--color-text-300);
        }
        .page-size select {
            padding: 4px 8px;
            border: 1px solid var(--color-component-border-300);
            border-radius: 4px;
            background: var(--color-component-bg-100);
        }
        .page-info {
            font-size: 13px;
            color: var(--color-text-300);
        }
        .page-nav {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .page-number {
            font-size: 13px;
            padding: 0 8px;
            color: var(--color-text-300);
        }
    `],
    standalone: true,
    imports: [SharedModule],
})
export class ReferralHistoryComponent implements OnInit {
    referrals: Referral[] = [];
    totalItems: number = 0;
    currentPage: number = 1;
    itemsPerPage: number = 10;
    pageSizes: number[] = [10, 25, 50, 100];

    constructor(
        private dataService: DataService,
        private notificationService: NotificationService,
    ) {}

    ngOnInit(): void {
        this.loadReferrals();
    }

    get totalPages(): number {
        return Math.max(1, Math.ceil(this.totalItems / this.itemsPerPage));
    }

    get startIndex(): number {
        return (this.currentPage - 1) * this.itemsPerPage;
    }

    get endIndex(): number {
        return Math.min(this.startIndex + this.itemsPerPage, this.totalItems);
    }

    loadReferrals(): void {
        this.dataService
            .query<ReferralListResponse>(GET_REFERRALS, {
                take: this.itemsPerPage,
                skip: this.startIndex,
            })
            .single$.subscribe({
                next: (response) => {
                    this.referrals = response.referrals.items;
                    this.totalItems = response.referrals.totalItems;
                },
                error: () => {
                    this.notificationService.error('Failed to load referrals');
                },
            });
    }

    goToPage(page: number): void {
        if (page < 1 || page > this.totalPages) return;
        this.currentPage = page;
        this.loadReferrals();
    }

    onItemsPerPageChange(event: Event): void {
        const target = event.target as HTMLSelectElement;
        this.itemsPerPage = +target.value;
        this.currentPage = 1;
        this.loadReferrals();
    }

    refresh(): void {
        this.loadReferrals();
    }
}

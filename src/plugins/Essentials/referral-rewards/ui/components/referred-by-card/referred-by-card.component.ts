import { ChangeDetectionStrategy, Component, OnInit, AfterViewInit, ElementRef } from '@angular/core';
import { UntypedFormGroup } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Observable, of } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { CustomDetailComponent, DataService } from '@vendure/admin-ui/core';
import gql from 'graphql-tag';

interface ReferredBy {
    id: string;
    referrer: { id: string; firstName: string; lastName: string };
    status: string;
    points: number;
    createdAt: string;
}

interface CustomerReferredByResponse {
    customer: {
        id: string;
        referredBy: ReferredBy | null;
    };
}

const GET_CUSTOMER_REFERRED_BY = gql`
    query GetCustomerReferredBy($customerId: ID!) {
        customer(id: $customerId) {
            id
            referredBy {
                id
                referrer {
                    id
                    firstName
                    lastName
                }
                status
                points
                createdAt
            }
        }
    }
`;

@Component({
    standalone: false,
    selector: 'ex-referred-by-card',
    template: `
        <ng-container *ngIf="referredBy$ | async as referredBy">
            <vdr-card>
                <div class="referred-by-content">
                    <div class="referred-by-label">
                        <clr-icon shape="users" size="16"></clr-icon>
                        Referred by
                    </div>
                    <div class="referred-by-name">
                        <a [routerLink]="['/customer/customers', referredBy.referrer.id]">
                            {{ referredBy.referrer.firstName }} {{ referredBy.referrer.lastName }}
                        </a>
                    </div>
                    <div class="referred-by-meta">
                        <span class="status-badge" [ngClass]="'status-' + referredBy.status.toLowerCase()">
                            {{ referredBy.status }}
                        </span>
                        <span *ngIf="referredBy.points > 0" class="points">{{ referredBy.points }} pts</span>
                    </div>
                </div>
            </vdr-card>
        </ng-container>
    `,
    styles: [`
        .referred-by-content {
            text-align: center;
        }
        .referred-by-label {
            color: #666;
            font-size: 12px;
            margin-bottom: 4px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
        }
        .referred-by-name {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 8px;
        }
        .referred-by-name a {
            color: #0366d6;
            text-decoration: none;
        }
        .referred-by-name a:hover {
            text-decoration: underline;
        }
        .referred-by-meta {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        .status-badge {
            padding: 2px 10px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
        }
        .status-registered {
            background: #fff3cd;
            color: #856404;
        }
        .status-eligible {
            background: #cce5ff;
            color: #004085;
        }
        .status-claimed {
            background: #d4edda;
            color: #155724;
        }
        .points {
            color: #28a745;
            font-weight: 600;
            font-size: 13px;
        }
    `],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReferredByCardComponent implements CustomDetailComponent, OnInit, AfterViewInit {
    entity$!: Observable<any>;
    detailForm!: UntypedFormGroup;
    referredBy$!: Observable<ReferredBy | null>;

    constructor(
        private route: ActivatedRoute,
        private dataService: DataService,
        private elementRef: ElementRef,
    ) {}

    ngOnInit(): void {
        this.referredBy$ = this.route.paramMap.pipe(
            map(paramMap => paramMap.get('id')),
            switchMap(id => {
                if (!id) return of(null);
                return this.dataService
                    .query<CustomerReferredByResponse>(GET_CUSTOMER_REFERRED_BY, { customerId: id })
                    .mapSingle(data => data.customer?.referredBy ?? null);
            }),
        );
    }

    ngAfterViewInit(): void {
        setTimeout(() => {
            const host = this.elementRef.nativeElement;
            const sidebar = host.closest('vdr-page-detail-layout')?.querySelector('vdr-page-detail-sidebar');
            if (sidebar) {
                sidebar.appendChild(host);
            }
        }, 100);
    }
}

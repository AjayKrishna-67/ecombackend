import { ChangeDetectionStrategy, Component, OnInit, OnDestroy } from '@angular/core';
import { UntypedFormGroup } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Observable, BehaviorSubject, Subject, combineLatest, of } from 'rxjs';
import { map, startWith, distinctUntilChanged, takeUntil, switchMap } from 'rxjs/operators';
import { CustomDetailComponent, DataService } from '@vendure/admin-ui/core';
import gql from 'graphql-tag';

interface Referral {
    id: string;
    createdAt: string;
    referredCustomer: { id: string; firstName: string; lastName: string };
    status: string;
    points: number;
    isScratched: boolean;
    note: string;
    order: { id: string; code: string } | null;
}

interface ReferralsForCustomerResponse {
    referralsForCustomer: {
        items: Referral[];
        totalItems: number;
    };
}

const GET_REFERRALS_FOR_CUSTOMER = gql`
    query GetReferralsForCustomer($customerId: ID!, $take: Int, $skip: Int) {
        referralsForCustomer(customerId: $customerId, take: $take, skip: $skip) {
            items {
                id
                createdAt
                referredCustomer {
                    id
                    firstName
                    lastName
                }
                status
                points
                isScratched
                note
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
    standalone: false,
    selector: 'ex-referral-list',
    templateUrl: './referral-list.component.html',
    styleUrls: ['./referral-list.component.scss'],
    changeDetection: ChangeDetectionStrategy.Default,
})
export class ReferralListComponent implements CustomDetailComponent, OnInit, OnDestroy {
    entity$!: Observable<any>;
    detailForm!: UntypedFormGroup;

    customerId$!: Observable<string | undefined>;
    referrals$!: Observable<Referral[]>;
    referralsTotalItems$!: Observable<number>;
    referralsCurrentPage$!: Observable<number>;
    referralsItemsPerPage$!: Observable<number>;
    private refresh$ = new BehaviorSubject<boolean>(true);
    private destroy$ = new Subject<void>();

    constructor(
        private route: ActivatedRoute,
        private router: Router,
        private dataService: DataService,
    ) {}

    ngOnInit(): void {
        this.customerId$ = this.route.paramMap.pipe(
            map(paramMap => {
                const id = paramMap.get('id');
                return id === null ? undefined : id;
            }),
        );

        this.referralsCurrentPage$ = this.route.paramMap.pipe(
            map(qpm => qpm.get('referralsPage')),
            map(page => (!page ? 1 : +page)),
            startWith(1),
            distinctUntilChanged(),
        );

        this.referralsItemsPerPage$ = this.route.paramMap.pipe(
            map(qpm => qpm.get('referralsPerPage')),
            map(perPage => (!perPage ? 10 : +perPage)),
            startWith(10),
            distinctUntilChanged(),
        );

        const collection$ = combineLatest([
            this.customerId$,
            this.referralsCurrentPage$,
            this.referralsItemsPerPage$,
            this.refresh$,
        ]).pipe(
            takeUntil(this.destroy$),
            switchMap(([id, currentPage, itemsPerPage]) => {
                const take = itemsPerPage;
                const skip = (currentPage - 1) * itemsPerPage;
                if (!id) {
                    return of(null);
                }
                return this.dataService
                    .query<ReferralsForCustomerResponse>(GET_REFERRALS_FOR_CUSTOMER, {
                        customerId: id,
                        take,
                        skip,
                    })
                    .mapSingle(data => data.referralsForCustomer);
            }),
        );

        this.referrals$ = collection$.pipe(
            map(result => (result ? result.items : [])),
        );
        this.referralsTotalItems$ = collection$.pipe(
            map(result => (result ? result.totalItems : 0)),
        );
    }

    ngOnDestroy(): void {
        this.destroy$.next();
        this.destroy$.complete();
    }

    setReferralsPageNumber(page: number): void {
        this.setParam('referralsPage', page);
    }

    setReferralsItemsPerPage(perPage: number): void {
        this.setParam('referralsPerPage', perPage);
    }

    refresh(): void {
        this.refresh$.next(true);
    }

    getStatusClass(status: string): string {
        return 'status-' + status.toLowerCase();
    }

    private setParam(key: string, value: any): void {
        this.router.navigate(['./', { ...this.route.snapshot.params, [key]: value }], {
            relativeTo: this.route,
            queryParamsHandling: 'merge',
        });
    }
}

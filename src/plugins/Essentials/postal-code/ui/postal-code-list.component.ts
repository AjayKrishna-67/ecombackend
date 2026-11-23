import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit, OnDestroy } from '@angular/core';
import { FormControl } from '@angular/forms';
import {
    NotificationService,
    SharedModule,
    ModalService,
} from '@vendure/admin-ui/core';
import { Apollo } from 'apollo-angular';
import gql from 'graphql-tag';
import { BehaviorSubject, Observable, combineLatest, Subject } from 'rxjs';
import { debounceTime, map, startWith, switchMap, takeUntil } from 'rxjs/operators';

const GET_POSTAL_CODES = gql`
    query GetPostalCodes($options: PostalCodeListOptions) {
        postalCodes(options: $options) {
            items {
                id
                createdAt
                updatedAt
                code
                isAnywhere
                areas { id name }
            }
            totalItems
        }
    }
`;

const CREATE_POSTAL_CODE = gql`
    mutation CreatePostalCode($input: CreatePostalCodeInput!) {
        createPostalCode(input: $input) {
            id
            code
            isAnywhere
        }
    }
`;

const DELETE_POSTAL_CODE = gql`
    mutation DeletePostalCode($id: ID!) {
        deletePostalCode(id: $id) {
            result
            message
        }
    }
`;

interface PostalCode {
    id: string;
    createdAt: string;
    updatedAt: string;
    code: string;
    isAnywhere: boolean;
    areas: Array<{ id: string; name: string }>;
}

@Component({
    selector: 'postal-code-list',
    template: `
        <!-- Header with Add Button -->
        <vdr-page-block>
            <vdr-action-bar>
                <vdr-ab-left>
                    <div class="items-count" *ngIf="currentMode === 'predefined'">
                        <span class="count">{{ (totalItems$ | async) || 0 }}</span> postal codes configured
                    </div>
                </vdr-ab-left>
                <vdr-ab-right>
                    <button
                        class="btn btn-primary"
                        *ngIf="currentMode === 'predefined'"
                        [routerLink]="['./create']"
                    >
                        <clr-icon shape="plus"></clr-icon>
                        Add Postal Code
                    </button>
                </vdr-ab-right>
            </vdr-action-bar>
        </vdr-page-block>

        <!-- Mode Configuration Card -->
        <vdr-page-block>
            <vdr-card>
                <div class="config-container">
                    <div class="config-left">
                        <div class="config-icon" [class.anywhere]="currentMode === 'anywhere'" [class.specific]="currentMode === 'predefined'">
                            <clr-icon [attr.shape]="currentMode === 'anywhere' ? 'world' : 'map-marker'" size="24"></clr-icon>
                        </div>
                        <div class="config-text">
                            <h3>{{ currentMode === 'anywhere' ? 'All Areas' : 'Specific Areas' }}</h3>
                            <p>{{ currentMode === 'anywhere' ? 'Accepting orders from all postal codes' : 'Only accepting orders from listed postal codes' }}</p>
                        </div>
                    </div>
                    <div class="config-right">
                        <div class="switch-container">
                            <span class="switch-label" [class.active]="currentMode === 'anywhere'">All</span>
                            <label class="switch">
                                <input
                                    type="checkbox"
                                    [checked]="currentMode === 'predefined'"
                                    (change)="toggleMode()"
                                >
                                <span class="slider"></span>
                            </label>
                            <span class="switch-label" [class.active]="currentMode === 'predefined'">Specific</span>
                        </div>
                    </div>
                </div>
            </vdr-card>
        </vdr-page-block>

        <!-- Postal Codes Grid -->
        <ng-container *ngIf="currentMode === 'predefined'">
            <vdr-page-block *ngIf="(totalItems$ | async) as total">
                <vdr-card *ngIf="total > 0" [title]="'Serviceable Areas'">
                    <div class="postal-grid">
                        <a class="postal-card"
                           *ngFor="let postalCode of items$ | async"
                           [routerLink]="['./', postalCode.id]"
                        >
                            <div class="postal-code">{{ postalCode.code }}</div>
                            <div class="area-badge" *ngIf="postalCode.areas?.length">
                                <clr-icon shape="map-marker" size="12"></clr-icon>
                                {{ postalCode.areas.length }} area{{ postalCode.areas.length > 1 ? 's' : '' }}
                            </div>
                            <button
                                class="delete-btn"
                                (click)="deletePostalCode(postalCode); $event.preventDefault(); $event.stopPropagation()"
                                title="Delete"
                            >
                                <clr-icon shape="trash" size="14"></clr-icon>
                            </button>
                        </a>
                    </div>

                    <div class="grid-footer">
                        <div class="per-page">
                            <select [value]="itemsPerPage" (change)="setItemsPerPage($any($event.target).value)">
                                <option value="16">16 per page</option>
                                <option value="32">32 per page</option>
                                <option value="64">64 per page</option>
                            </select>
                        </div>
                        <div class="pagination-info">
                            Showing {{ (currentPage - 1) * itemsPerPage + 1 }} - {{ min(currentPage * itemsPerPage, total) }} of {{ total }}
                        </div>
                        <div class="pagination-buttons" *ngIf="total > itemsPerPage">
                            <button
                                class="page-btn"
                                [disabled]="currentPage === 1"
                                (click)="prevPage()"
                            >
                                <clr-icon shape="angle" dir="left"></clr-icon>
                            </button>
                            <span class="page-num">{{ currentPage }}</span>
                            <button
                                class="page-btn"
                                [disabled]="currentPage * itemsPerPage >= total"
                                (click)="nextPage()"
                            >
                                <clr-icon shape="angle" dir="right"></clr-icon>
                            </button>
                        </div>
                    </div>
                </vdr-card>
            </vdr-page-block>

            <!-- Empty State -->
            <vdr-page-block *ngIf="(totalItems$ | async) === 0">
                <vdr-card>
                    <div class="empty-state">
                        <div class="empty-icon">
                            <clr-icon shape="map-marker" size="48"></clr-icon>
                        </div>
                        <h3>No Postal Codes Yet</h3>
                        <p>Start by adding postal codes where you provide delivery service</p>
                        <button class="btn btn-primary btn-lg" [routerLink]="['./create']">
                            <clr-icon shape="plus"></clr-icon>
                            Add Your First Postal Code
                        </button>
                    </div>
                </vdr-card>
            </vdr-page-block>
        </ng-container>

        <!-- All Areas Mode Display -->
        <vdr-page-block *ngIf="currentMode === 'anywhere'">
            <vdr-card>
                <div class="anywhere-display">
                    <div class="anywhere-icon">
                        <clr-icon shape="check-circle" size="48"></clr-icon>
                    </div>
                    <h3>Delivering Everywhere</h3>
                    <p>Your store accepts orders from all postal codes without restriction</p>
                </div>
            </vdr-card>
        </vdr-page-block>
    `,
    styles: [`
        /* Items Count */
        .items-count {
            font-size: 14px;
            color: var(--color-text-300);
        }
        .items-count .count {
            font-weight: 600;
            color: var(--color-primary-500);
        }

        /* Config Card */
        .config-container {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 0;
        }
        .config-left {
            display: flex;
            align-items: center;
            gap: 16px;
        }
        .config-icon {
            width: 48px;
            height: 48px;
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .config-icon.anywhere {
            background: linear-gradient(135deg, #3b82f6, #1d4ed8);
            color: white;
        }
        .config-icon.specific {
            background: linear-gradient(135deg, #10b981, #059669);
            color: white;
        }
        .config-text h3 {
            margin: 0 0 4px 0;
            font-size: 16px;
            font-weight: 600;
            color: var(--color-text-100);
        }
        .config-text p {
            margin: 0;
            font-size: 13px;
            color: var(--color-text-300);
        }

        /* Switch */
        .switch-container {
            display: flex;
            align-items: center;
            gap: 12px;
            background: var(--color-component-bg-200);
            padding: 8px 16px;
            border-radius: 24px;
        }
        .switch-label {
            font-size: 13px;
            font-weight: 500;
            color: var(--color-text-300);
            transition: color 0.2s;
        }
        .switch-label.active {
            color: var(--color-text-100);
        }
        .switch {
            position: relative;
            width: 44px;
            height: 24px;
        }
        .switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }
        .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: #3b82f6;
            transition: 0.3s;
            border-radius: 24px;
        }
        .slider:before {
            position: absolute;
            content: "";
            height: 18px;
            width: 18px;
            left: 3px;
            bottom: 3px;
            background: white;
            transition: 0.3s;
            border-radius: 50%;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }
        input:checked + .slider {
            background: #10b981;
        }
        input:checked + .slider:before {
            transform: translateX(20px);
        }

        /* Grid Layout */
        .postal-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 16px;
            margin-bottom: 20px;
        }

        /* Postal Card */
        .postal-card {
            background: var(--color-component-bg-200);
            border: 1px solid var(--color-component-border-100);
            border-radius: 10px;
            padding: 16px;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 12px;
            transition: all 0.2s ease;
            cursor: pointer;
            text-decoration: none;
            position: relative;
        }
        .postal-card:hover {
            border-color: var(--color-primary-300);
            background: var(--color-component-bg-100);
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        .postal-code {
            font-family: 'SF Mono', Monaco, 'Courier New', monospace;
            font-size: 18px;
            font-weight: 700;
            color: var(--color-text-100);
            letter-spacing: 1px;
        }
        .area-badge {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 11px;
            font-weight: 500;
            color: var(--color-primary-600);
            background: var(--color-primary-100, rgba(59, 130, 246, 0.1));
            padding: 2px 8px;
            border-radius: 12px;
        }
        .delete-btn {
            position: absolute;
            top: 8px;
            right: 8px;
            width: 24px;
            height: 24px;
            border: none;
            background: transparent;
            cursor: pointer;
            border-radius: 4px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
            color: var(--color-text-300);
            opacity: 0;
        }
        .postal-card:hover .delete-btn {
            opacity: 1;
        }
        .delete-btn:hover {
            background: #ef4444;
            color: white;
        }

        /* Grid Footer */
        .grid-footer {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-top: 16px;
            border-top: 1px solid var(--color-component-border-100);
        }
        .per-page select {
            padding: 6px 12px;
            border: 1px solid var(--color-component-border-100);
            border-radius: 6px;
            background: var(--color-component-bg-100);
            font-size: 13px;
            color: var(--color-text-200);
            cursor: pointer;
        }
        .pagination-info {
            font-size: 13px;
            color: var(--color-text-300);
        }
        .pagination-buttons {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .page-btn {
            width: 32px;
            height: 32px;
            border: 1px solid var(--color-component-border-100);
            background: var(--color-component-bg-100);
            border-radius: 6px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--color-text-200);
            transition: all 0.2s;
        }
        .page-btn:hover:not(:disabled) {
            background: var(--color-primary-500);
            border-color: var(--color-primary-500);
            color: white;
        }
        .page-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .page-num {
            font-size: 14px;
            font-weight: 600;
            color: var(--color-text-100);
            min-width: 24px;
            text-align: center;
        }

        /* Empty State */
        .empty-state {
            text-align: center;
            padding: 60px 24px;
        }
        .empty-icon {
            width: 80px;
            height: 80px;
            margin: 0 auto 20px;
            background: var(--color-component-bg-200);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--color-text-300);
        }
        .empty-state h3 {
            margin: 0 0 8px;
            font-size: 20px;
            font-weight: 600;
            color: var(--color-text-100);
        }
        .empty-state p {
            margin: 0 0 24px;
            font-size: 14px;
            color: var(--color-text-300);
        }
        .btn-lg {
            padding: 12px 24px !important;
            font-size: 14px !important;
        }

        /* Anywhere Display */
        .anywhere-display {
            text-align: center;
            padding: 60px 24px;
        }
        .anywhere-icon {
            width: 80px;
            height: 80px;
            margin: 0 auto 20px;
            background: linear-gradient(135deg, #10b981, #059669);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
        }
        .anywhere-display h3 {
            margin: 0 0 8px;
            font-size: 20px;
            font-weight: 600;
            color: var(--color-text-100);
        }
        .anywhere-display p {
            margin: 0;
            font-size: 14px;
            color: var(--color-text-300);
        }

        /* Responsive Grid */
        @media (max-width: 1200px) {
            .postal-grid {
                grid-template-columns: repeat(3, 1fr);
            }
        }
        @media (max-width: 900px) {
            .postal-grid {
                grid-template-columns: repeat(2, 1fr);
            }
        }
        @media (max-width: 600px) {
            .postal-grid {
                grid-template-columns: 1fr;
            }
        }
    `],
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: true,
    imports: [SharedModule],
})
export class PostalCodeListComponent implements OnInit, OnDestroy {
    items$!: Observable<PostalCode[]>;
    totalItems$!: Observable<number>;
    itemsPerPage$ = new BehaviorSubject<number>(16);
    currentPage$ = new BehaviorSubject<number>(1);
    searchTermControl = new FormControl('');
    currentMode: 'anywhere' | 'predefined' = 'predefined';

    // Component properties for template binding (avoid async pipe in event handlers)
    currentPage = 1;
    itemsPerPage = 16;

    private refresh$ = new BehaviorSubject<void>(undefined);
    private destroy$ = new Subject<void>();
    private anywhereRecord: PostalCode | null = null;

    constructor(
        private apollo: Apollo,
        private notificationService: NotificationService,
        private modalService: ModalService,
        private changeDetectorRef: ChangeDetectorRef
    ) {}

    ngOnInit() {
        const queryResult$ = combineLatest([
            this.currentPage$,
            this.itemsPerPage$,
            this.refresh$,
        ]).pipe(
            switchMap(([currentPage, itemsPerPage]) => {
                const skip = (currentPage - 1) * itemsPerPage;
                return this.apollo
                    .watchQuery<{ postalCodes: { items: PostalCode[]; totalItems: number } }>({
                        query: GET_POSTAL_CODES,
                        variables: {
                            options: {
                                skip,
                                take: itemsPerPage,
                            },
                        },
                        fetchPolicy: 'network-only',
                    })
                    .valueChanges.pipe(map(result => result.data.postalCodes));
            }),
            takeUntil(this.destroy$)
        );

        queryResult$.subscribe(result => {
            const anywhereItem = result.items.find(item => item.isAnywhere);
            if (anywhereItem) {
                this.anywhereRecord = anywhereItem;
                this.currentMode = 'anywhere';
            } else {
                this.anywhereRecord = null;
                this.currentMode = 'predefined';
            }
            this.changeDetectorRef.markForCheck();
        });

        this.items$ = queryResult$.pipe(
            map(result => result.items.filter(item => !item.isAnywhere))
        );
        this.totalItems$ = queryResult$.pipe(
            map(result => result.items.filter(item => !item.isAnywhere).length)
        );
    }

    ngOnDestroy() {
        this.destroy$.next();
        this.destroy$.complete();
    }

    min(a: number, b: number): number {
        return Math.min(a, b);
    }

    setPageNumber(page: number) {
        this.currentPage = page;
        this.currentPage$.next(page);
    }

    setItemsPerPage(perPage: number | string) {
        const value = Number(perPage);
        this.itemsPerPage = value;
        this.currentPage = 1;
        this.itemsPerPage$.next(value);
        this.currentPage$.next(1);
    }

    prevPage() {
        if (this.currentPage > 1) {
            this.setPageNumber(this.currentPage - 1);
        }
    }

    nextPage() {
        this.setPageNumber(this.currentPage + 1);
    }

    toggleMode() {
        const newMode = this.currentMode === 'anywhere' ? 'predefined' : 'anywhere';
        this.switchMode(newMode);
    }

    switchMode(mode: 'anywhere' | 'predefined') {
        if (mode === this.currentMode) return;

        if (mode === 'anywhere') {
            this.apollo
                .mutate({
                    mutation: CREATE_POSTAL_CODE,
                    variables: {
                        input: {
                            code: 'ANYWHERE',
                            isAnywhere: true,
                        },
                    },
                })
                .subscribe({
                    next: () => {
                        this.currentMode = 'anywhere';
                        this.notificationService.success('Now accepting all postal codes');
                        this.refresh$.next();
                    },
                    error: () => {
                        this.notificationService.error('Failed to switch mode');
                    },
                });
        } else {
            if (this.anywhereRecord) {
                this.apollo
                    .mutate({
                        mutation: DELETE_POSTAL_CODE,
                        variables: { id: this.anywhereRecord.id },
                    })
                    .subscribe({
                        next: () => {
                            this.currentMode = 'predefined';
                            this.anywhereRecord = null;
                            this.notificationService.success('Now using specific postal codes');
                            this.refresh$.next();
                        },
                        error: () => {
                            this.notificationService.error('Failed to switch mode');
                        },
                    });
            } else {
                this.currentMode = 'predefined';
                this.changeDetectorRef.markForCheck();
            }
        }
    }

    deletePostalCode(postalCode: PostalCode) {
        this.modalService
            .dialog({
                title: 'Remove Postal Code',
                body: `Remove "${postalCode.code}" from your serviceable areas?`,
                buttons: [
                    { type: 'secondary', label: 'Cancel' },
                    { type: 'danger', label: 'Remove', returnValue: true },
                ],
            })
            .pipe(
                switchMap(response => {
                    if (response) {
                        return this.apollo.mutate({
                            mutation: DELETE_POSTAL_CODE,
                            variables: { id: postalCode.id },
                        });
                    }
                    return [];
                })
            )
            .subscribe({
                next: () => {
                    this.notificationService.success('Postal code removed');
                    this.refresh$.next();
                },
                error: () => {
                    this.notificationService.error('Failed to remove postal code');
                },
            });
    }
}

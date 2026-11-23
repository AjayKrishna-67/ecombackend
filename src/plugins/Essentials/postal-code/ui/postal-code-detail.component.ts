import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
    NotificationService,
    SharedModule,
    ModalService,
} from '@vendure/admin-ui/core';
import { Apollo } from 'apollo-angular';
import gql from 'graphql-tag';
import { Subject, of } from 'rxjs';
import { map, switchMap, takeUntil } from 'rxjs/operators';

const GET_POSTAL_CODE = gql`
    query GetPostalCode($id: ID!) {
        postalCode(id: $id) {
            id
            createdAt
            updatedAt
            code
            isAnywhere
            areas { id name enabled createdAt }
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

const UPDATE_POSTAL_CODE = gql`
    mutation UpdatePostalCode($input: UpdatePostalCodeInput!) {
        updatePostalCode(input: $input) {
            id
            code
            isAnywhere
        }
    }
`;

const GET_CHANNEL_POSTAL_CODES = gql`
    query GetChannelPostalCodes {
        postalCodes(options: { take: 2000 }) {
            items {
                id
                code
            }
        }
    }
`;

const CREATE_AREA = gql`
    mutation CreatePostalCodeArea($input: CreatePostalCodeAreaInput!) {
        createPostalCodeArea(input: $input) {
            id
            name
            enabled
        }
    }
`;

const UPDATE_AREA = gql`
    mutation UpdatePostalCodeArea($input: UpdatePostalCodeAreaInput!) {
        updatePostalCodeArea(input: $input) {
            id
            name
            enabled
        }
    }
`;

const DELETE_AREA = gql`
    mutation DeletePostalCodeArea($id: ID!) {
        deletePostalCodeArea(id: $id) {
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
    areas: Area[];
}

interface Area {
    id: string;
    name: string;
    enabled: boolean;
    createdAt?: string;
}

@Component({
    selector: 'postal-code-detail',
    template: `
        <vdr-page-block>
            <vdr-action-bar>
                <vdr-ab-left></vdr-ab-left>
                <vdr-ab-right>
                    <button
                        class="btn btn-primary"
                        *ngIf="isNew; else updateButton"
                        (click)="create()"
                        [disabled]="detailForm.invalid || detailForm.pristine"
                    >
                        {{ 'common.create' | translate }}
                    </button>
                    <ng-template #updateButton>
                        <button
                            class="btn btn-primary"
                            (click)="save()"
                            [disabled]="detailForm.invalid || detailForm.pristine"
                        >
                            {{ 'common.update' | translate }}
                        </button>
                    </ng-template>
                </vdr-ab-right>
            </vdr-action-bar>
        </vdr-page-block>

        <form class="form" [formGroup]="detailForm">
            <vdr-page-detail-layout>
                <vdr-page-detail-sidebar>
                    <vdr-card *ngIf="entity" [title]="'common.details' | translate">
                        <vdr-page-entity-info [entity]="entity" />
                    </vdr-card>
                </vdr-page-detail-sidebar>

                <vdr-page-block>
                    <vdr-card [title]="isNew ? 'Create Postal Code' : 'Edit Postal Code'">
                        <div class="form-grid">
                            <vdr-form-field
                                [label]="'Postal Code'"
                                for="code"
                            >
                                <input
                                    #codeInput
                                    id="code"
                                    type="text"
                                    formControlName="code"
                                    placeholder="Enter postal code (e.g., 625001)"
                                    data-exclude-postal-dropdown="true"
                                    autocomplete="off"
                                />
                            </vdr-form-field>
                        </div>
                    </vdr-card>

                    <!-- Areas Section (only for existing postal codes) -->
                    <vdr-card *ngIf="!isNew" [title]="'Areas / Landmarks (' + areas.length + ')'">
                        <div class="areas-section">
                            <!-- Add Area Form -->
                            <div class="add-area-row">
                                <input
                                    type="text"
                                    class="clr-input add-area-input"
                                    [(ngModel)]="newAreaName"
                                    [ngModelOptions]="{ standalone: true }"
                                    placeholder="Enter area name (e.g., Anna Nagar)"
                                    (keyup.enter)="addArea()"
                                    data-exclude-postal-dropdown="true"
                                    autocomplete="off"
                                />
                                <button
                                    class="btn btn-sm btn-secondary"
                                    (click)="addArea()"
                                    [disabled]="!newAreaName?.trim()"
                                >
                                    <clr-icon shape="plus" size="12"></clr-icon>
                                    Add
                                </button>
                            </div>

                            <!-- Area Table -->
                            <table class="table" *ngIf="areas.length > 0">
                                <thead>
                                    <tr>
                                        <th>Area Name</th>
                                        <th class="text-center">Service Status</th>
                                        <th class="text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr *ngFor="let area of areas; trackBy: trackAreaById"
                                        [class.disabled-row]="!area.enabled">
                                        <td>
                                            <ng-container *ngIf="editingAreaId !== area.id; else editMode">
                                                <span class="area-name" [class.text-muted]="!area.enabled">
                                                    {{ area.name }}
                                                </span>
                                            </ng-container>
                                            <ng-template #editMode>
                                                <input
                                                    type="text"
                                                    class="clr-input edit-input"
                                                    [(ngModel)]="editAreaName"
                                                    [ngModelOptions]="{ standalone: true }"
                                                    (keyup.enter)="saveEditArea(area)"
                                                    (keyup.escape)="cancelEditArea()"
                                                    data-exclude-postal-dropdown="true"
                                                    autocomplete="off"
                                                />
                                            </ng-template>
                                        </td>
                                        <td class="text-center">
                                            <vdr-chip
                                                [colorType]="area.enabled ? 'success' : 'error'"
                                                [icon]="area.enabled ? 'check' : 'times'"
                                            >
                                                {{ area.enabled ? 'Available' : 'Unavailable' }}
                                            </vdr-chip>
                                        </td>
                                        <td class="text-right">
                                            <ng-container *ngIf="editingAreaId !== area.id; else editActions">
                                                <vdr-dropdown>
                                                    <button class="btn btn-sm btn-outline icon-btn" vdrDropdownTrigger>
                                                        <clr-icon shape="ellipsis-vertical" size="16"></clr-icon>
                                                    </button>
                                                    <vdr-dropdown-menu>
                                                        <button
                                                            type="button"
                                                            vdrDropdownItem
                                                            (click)="toggleEnabled(area)"
                                                        >
                                                            <clr-icon [attr.shape]="area.enabled ? 'ban' : 'check'" size="16"></clr-icon>
                                                            {{ area.enabled ? 'Mark Unavailable' : 'Mark Available' }}
                                                        </button>
                                                        <button
                                                            type="button"
                                                            vdrDropdownItem
                                                            (click)="startEditArea(area)"
                                                        >
                                                            <clr-icon shape="pencil" size="16"></clr-icon>
                                                            Rename
                                                        </button>
                                                        <div class="dropdown-divider"></div>
                                                        <button
                                                            type="button"
                                                            class="text-danger"
                                                            vdrDropdownItem
                                                            (click)="deleteArea(area)"
                                                        >
                                                            <clr-icon shape="trash" size="16"></clr-icon>
                                                            Delete
                                                        </button>
                                                    </vdr-dropdown-menu>
                                                </vdr-dropdown>
                                            </ng-container>
                                            <ng-template #editActions>
                                                <button
                                                    class="btn btn-sm btn-success-outline icon-btn"
                                                    (click)="saveEditArea(area)"
                                                    [disabled]="!editAreaName?.trim()"
                                                    title="Save"
                                                >
                                                    <clr-icon shape="check" size="14"></clr-icon>
                                                </button>
                                                <button
                                                    class="btn btn-sm btn-outline icon-btn"
                                                    (click)="cancelEditArea()"
                                                    title="Cancel"
                                                >
                                                    <clr-icon shape="times" size="14"></clr-icon>
                                                </button>
                                            </ng-template>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>

                            <!-- Empty State -->
                            <div class="areas-empty" *ngIf="areas.length === 0">
                                <clr-icon shape="map" size="32"></clr-icon>
                                <p>No areas configured. Add areas so delivery persons can identify the locality.</p>
                            </div>
                        </div>
                    </vdr-card>
                </vdr-page-block>
            </vdr-page-detail-layout>
        </form>
    `,
    styles: [`
        .form-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 16px;
        }
        .areas-section {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .add-area-row {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        .add-area-input {
            flex: 1;
        }
        .table {
            width: 100%;
            margin: 0;
        }
        .table th {
            font-size: 0.7rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .text-center { text-align: center; }
        .text-right { text-align: right; }
        .text-muted { opacity: 0.5; }
        .text-danger { color: var(--color-error-500); }
        .disabled-row {
            opacity: 0.7;
            background: var(--color-component-bg-200);
        }
        .edit-input {
            width: 100%;
        }
        .icon-btn {
            padding: 0 6px;
            min-width: unset;
        }
        .dropdown-divider {
            border-top: 1px solid var(--color-component-border-200);
            margin: 4px 0;
        }
        .areas-empty {
            text-align: center;
            padding: 32px 16px;
            color: var(--color-text-300);
        }
        .areas-empty p {
            margin: 8px 0 0;
            font-size: 13px;
        }
    `],
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: true,
    imports: [SharedModule],
})
export class PostalCodeDetailComponent implements OnInit, OnDestroy, AfterViewInit {
    @ViewChild('codeInput') codeInput!: ElementRef<HTMLInputElement>;

    entity: PostalCode | null = null;
    isNew = true;
    detailForm: FormGroup;

    // Area management
    areas: Area[] = [];
    newAreaName = '';
    editingAreaId: string | null = null;
    editAreaName = '';

    private destroy$ = new Subject<void>();

    constructor(
        private apollo: Apollo,
        private formBuilder: FormBuilder,
        private route: ActivatedRoute,
        private router: Router,
        private notificationService: NotificationService,
        private modalService: ModalService,
        private changeDetectorRef: ChangeDetectorRef,
    ) {
        this.detailForm = this.formBuilder.group({
            code: ['', Validators.required],
        });
    }

    ngOnInit() {
        this.route.paramMap
            .pipe(
                switchMap(params => {
                    const id = params.get('id');
                    if (id && id !== 'create') {
                        this.isNew = false;
                        return this.apollo
                            .watchQuery<{ postalCode: PostalCode }>({
                                query: GET_POSTAL_CODE,
                                variables: { id },
                                fetchPolicy: 'network-only',
                            })
                            .valueChanges.pipe(map(result => result.data.postalCode));
                    }
                    this.isNew = true;
                    return of(null);
                }),
                takeUntil(this.destroy$),
            )
            .subscribe(postalCode => {
                if (postalCode) {
                    this.entity = postalCode;
                    this.areas = [...(postalCode.areas || [])];
                    this.detailForm.patchValue({ code: postalCode.code });
                    this.detailForm.markAsPristine();
                }
                this.changeDetectorRef.markForCheck();
            });
    }

    ngAfterViewInit() {
        if (this.isNew && this.codeInput) {
            setTimeout(() => this.codeInput.nativeElement.focus(), 100);
        }
    }

    ngOnDestroy() {
        this.destroy$.next();
        this.destroy$.complete();
    }

    trackAreaById(_index: number, area: Area): string {
        return area.id;
    }

    // ─── Postal Code CRUD ───────────────────────────────────────────

    create() {
        if (this.detailForm.invalid) return;
        const code = this.detailForm.value.code.trim();
        this.apollo
            .query<{ postalCodes: { items: PostalCode[] } }>({
                query: GET_CHANNEL_POSTAL_CODES,
                fetchPolicy: 'network-only',
            })
            .subscribe({
                next: (result) => {
                    if (result.data.postalCodes.items.find(item => item.code === code)) {
                        this.notificationService.error(`Postal code "${code}" already exists`);
                        return;
                    }
                    this.apollo
                        .mutate({
                            mutation: CREATE_POSTAL_CODE,
                            variables: { input: { code, isAnywhere: false } },
                        })
                        .subscribe({
                            next: (createResult: any) => {
                                this.notificationService.success('Postal code created');
                                this.detailForm.markAsPristine();
                                this.router.navigate(['../', createResult.data.createPostalCode.id], {
                                    relativeTo: this.route,
                                });
                            },
                            error: () => this.notificationService.error('Failed to create postal code'),
                        });
                },
                error: () => this.notificationService.error('Failed to check for duplicate postal code'),
            });
    }

    save() {
        if (this.detailForm.invalid || !this.entity) return;
        const code = this.detailForm.value.code.trim();
        const currentId = this.entity.id;
        this.apollo
            .query<{ postalCodes: { items: PostalCode[] } }>({
                query: GET_CHANNEL_POSTAL_CODES,
                fetchPolicy: 'network-only',
            })
            .subscribe({
                next: (result) => {
                    if (result.data.postalCodes.items.find(item => item.code === code && item.id !== currentId)) {
                        this.notificationService.error(`Postal code "${code}" already exists`);
                        return;
                    }
                    this.apollo
                        .mutate({
                            mutation: UPDATE_POSTAL_CODE,
                            variables: { input: { id: currentId, code } },
                        })
                        .subscribe({
                            next: () => {
                                this.notificationService.success('Postal code updated');
                                this.detailForm.markAsPristine();
                                this.changeDetectorRef.markForCheck();
                            },
                            error: () => this.notificationService.error('Failed to update postal code'),
                        });
                },
                error: () => this.notificationService.error('Failed to check for duplicate postal code'),
            });
    }

    // ─── Area CRUD ──────────────────────────────────────────────────

    addArea() {
        const name = this.newAreaName?.trim();
        if (!name || !this.entity) return;
        this.apollo
            .mutate<{ createPostalCodeArea: Area }>({
                mutation: CREATE_AREA,
                variables: { input: { postalCodeId: this.entity.id, name } },
            })
            .subscribe({
                next: (result) => {
                    if (result.data) {
                        this.areas = [...this.areas, result.data.createPostalCodeArea];
                    }
                    this.newAreaName = '';
                    this.notificationService.success(`Area "${name}" added`);
                    this.changeDetectorRef.markForCheck();
                },
                error: (err) => {
                    const msg = err?.graphQLErrors?.[0]?.message || 'Failed to add area';
                    this.notificationService.error(msg);
                },
            });
    }

    toggleEnabled(area: Area) {
        const newEnabled = !area.enabled;
        this.apollo
            .mutate<{ updatePostalCodeArea: Area }>({
                mutation: UPDATE_AREA,
                variables: { input: { id: area.id, enabled: newEnabled } },
            })
            .subscribe({
                next: (result) => {
                    if (result.data) {
                        this.areas = this.areas.map(a =>
                            a.id === area.id ? { ...a, enabled: result.data!.updatePostalCodeArea.enabled } : a,
                        );
                    }
                    this.notificationService.success(
                        newEnabled ? `"${area.name}" marked as available` : `"${area.name}" marked as unavailable`,
                    );
                    this.changeDetectorRef.markForCheck();
                },
                error: (err) => {
                    const msg = err?.graphQLErrors?.[0]?.message || 'Failed to update area';
                    this.notificationService.error(msg);
                },
            });
    }

    startEditArea(area: Area) {
        this.editingAreaId = area.id;
        this.editAreaName = area.name;
        this.changeDetectorRef.markForCheck();
    }

    cancelEditArea() {
        this.editingAreaId = null;
        this.editAreaName = '';
        this.changeDetectorRef.markForCheck();
    }

    saveEditArea(area: Area) {
        const name = this.editAreaName?.trim();
        if (!name) return;
        this.apollo
            .mutate<{ updatePostalCodeArea: Area }>({
                mutation: UPDATE_AREA,
                variables: { input: { id: area.id, name } },
            })
            .subscribe({
                next: (result) => {
                    if (result.data) {
                        this.areas = this.areas.map(a =>
                            a.id === area.id ? { ...a, name: result.data!.updatePostalCodeArea.name } : a,
                        );
                    }
                    this.editingAreaId = null;
                    this.editAreaName = '';
                    this.notificationService.success('Area updated');
                    this.changeDetectorRef.markForCheck();
                },
                error: (err) => {
                    const msg = err?.graphQLErrors?.[0]?.message || 'Failed to update area';
                    this.notificationService.error(msg);
                },
            });
    }

    deleteArea(area: Area) {
        this.modalService
            .dialog({
                title: 'Delete Area',
                body: `Permanently delete area "${area.name}"? This cannot be undone. Consider marking it as unavailable instead.`,
                buttons: [
                    { type: 'secondary', label: 'Cancel' },
                    { type: 'danger', label: 'Delete', returnValue: true },
                ],
            })
            .pipe(
                switchMap(response => {
                    if (response) {
                        return this.apollo.mutate({
                            mutation: DELETE_AREA,
                            variables: { id: area.id },
                        });
                    }
                    return [];
                }),
            )
            .subscribe({
                next: () => {
                    this.areas = this.areas.filter(a => a.id !== area.id);
                    this.notificationService.success(`Area "${area.name}" deleted`);
                    this.changeDetectorRef.markForCheck();
                },
                error: () => this.notificationService.error('Failed to delete area'),
            });
    }
}

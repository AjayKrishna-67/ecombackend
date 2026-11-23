import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { ReactiveFormsModule, FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import {
    SharedModule,
    DataService,
    ModalService,
    AssetPickerDialogComponent,
} from '@vendure/admin-ui/core';
import { Apollo } from 'apollo-angular';
import gql from 'graphql-tag';

const GET_OFFERS = gql`
    query GetOffers {
        allBannerPopup {
            items {
                id
                asset {
                    id
                    name
                    source
                    preview
                    type
                    fileSize
                    mimeType
                    width
                    height
                    focalPoint { x y }
                    tags { id value }
                }
                product {
                    id
                    name
                }
                collection {
                    id
                    name
                }
                productVariant {
                    id
                    name
                    sku
                }
                isPreview
            }
        }
    }
`;

type TargetKind = 'product' | 'collection' | 'variant';

interface OfferRow {
    id: string;
    isPreview: boolean;
    asset: any;
    product: { id: string; name: string } | null;
    collection: { id: string; name: string } | null;
    productVariant: { id: string; name: string; sku: string } | null;
}

interface OptionRow {
    id: string;
    label: string;
}

@Component({
    selector: 'offer-management',
    template: `
        <vdr-page-block>
            <div class="content-tabs">
                <a class="content-tab" routerLink="/extensions/banner">Banners</a>
                <a class="content-tab active">Offers</a>
            </div>

            <vdr-action-bar>
                <vdr-ab-left>
                    <h3 class="offers-count">
                        {{ offers.length }} offer{{ offers.length === 1 ? '' : 's' }}
                    </h3>
                </vdr-ab-left>
                <vdr-ab-right>
                    <button
                        *ngIf="canCreateOffer"
                        class="btn btn-primary"
                        (click)="toggleCreateForm()"
                    >
                        <clr-icon shape="plus"></clr-icon>
                        {{ showCreateForm ? 'Cancel' : 'New offer' }}
                    </button>
                </vdr-ab-right>
            </vdr-action-bar>

            <vdr-card
                *ngIf="showCreateForm && (canCreateOffer || canUpdateOffer)"
                [title]="editingOfferId ? 'Edit offer' : 'Create new offer'"
            >
                <div class="create-form">
                    <div class="form-row">
                        <div class="form-col image-col">
                            <label class="field-label">Image <span class="req">*</span></label>
                            <div class="image-picker" (click)="pickAsset()">
                                <ng-container *ngIf="selectedAssetPreview; else emptyImage">
                                    <img [src]="selectedAssetPreview" />
                                    <div class="overlay">Change image</div>
                                </ng-container>
                                <ng-template #emptyImage>
                                    <div class="empty-image">
                                        <clr-icon shape="image" size="36"></clr-icon>
                                        <span>Pick from assets</span>
                                    </div>
                                </ng-template>
                            </div>
                            <small class="hint">Only one image per offer</small>
                        </div>

                        <div class="form-col target-col">
                            <label class="field-label">
                                Link to <span class="optional">(optional)</span>
                            </label>
                            <div class="target-tabs">
                                <button
                                    type="button"
                                    class="tab"
                                    [class.active]="targetKind === 'product'"
                                    (click)="setTargetKind('product')"
                                >
                                    Product
                                </button>
                                <button
                                    type="button"
                                    class="tab"
                                    [class.active]="targetKind === 'collection'"
                                    (click)="setTargetKind('collection')"
                                >
                                    Category
                                </button>
                                <button
                                    type="button"
                                    class="tab"
                                    [class.active]="targetKind === 'variant'"
                                    (click)="setTargetKind('variant')"
                                >
                                    SKU
                                </button>
                            </div>

                            <div class="search-wrapper">
                                <input
                                    type="text"
                                    class="search-input"
                                    [(ngModel)]="targetSearchTerm"
                                    (ngModelChange)="onTargetSearchChange()"
                                    [placeholder]="targetSearchLabel"
                                />
                                <ul *ngIf="targetOptions.length > 0" class="options">
                                    <li
                                        *ngFor="let opt of targetOptions"
                                        [class.selected]="opt.id === selectedTargetId"
                                        (click)="selectTarget(opt)"
                                    >
                                        {{ opt.label }}
                                    </li>
                                </ul>
                            </div>

                            <div *ngIf="selectedTargetLabel" class="selected-pill">
                                <clr-icon shape="check"></clr-icon>
                                {{ selectedTargetLabel }}
                                <button class="clear" type="button" (click)="clearTarget()">×</button>
                            </div>
                        </div>
                    </div>

                    <div class="preview-toggle">
                        <label class="toggle-label">
                            <input type="checkbox" [(ngModel)]="isPreviewMode" />
                            <span>Set as Preview</span>
                        </label>
                    </div>

                    <div class="form-actions">
                        <button class="btn btn-secondary" type="button" (click)="toggleCreateForm()">
                            Cancel
                        </button>
                        <button
                            class="btn btn-primary"
                            type="button"
                            [disabled]="!canSubmit()"
                            (click)="onSubmit()"
                        >
                            {{ editingOfferId ? 'Save changes' : 'Create offer' }}
                        </button>
                    </div>
                </div>
            </vdr-card>

            <div *ngIf="offers.length === 0" class="empty-state">
                <clr-icon shape="tag" size="64"></clr-icon>
                <h4>No offers yet</h4>
                <p>Create one to get started.</p>
            </div>

            <div *ngIf="offers.length > 0" class="offer-grid">
                <div *ngFor="let offer of offers" class="offer-card" [class.is-live]="offer.isPreview">
                    <div class="card-image" (click)="openPreview(offer)">
                        <img [src]="offer.asset.source" />
                        <span *ngIf="offer.isPreview" class="live-badge">
                            <clr-icon shape="check-circle" size="14"></clr-icon> Live
                        </span>
                        <span *ngIf="!offer.isPreview" class="draft-badge">Draft</span>
                    </div>
                    <div class="card-body">
                        <div class="card-target">
                            <span *ngIf="offer.product" class="badge badge-product">Product</span>
                            <span *ngIf="offer.collection" class="badge badge-collection">Category</span>
                            <span *ngIf="offer.productVariant" class="badge badge-variant">SKU</span>
                            <span
                                *ngIf="!offer.product && !offer.collection && !offer.productVariant"
                                class="badge badge-none"
                                >No link</span
                            >
                        </div>
                        <div class="card-name">
                            <ng-container *ngIf="offer.product">{{ offer.product.name }}</ng-container>
                            <ng-container *ngIf="offer.collection">{{ offer.collection.name }}</ng-container>
                            <ng-container *ngIf="offer.productVariant">
                                <code>{{ offer.productVariant.sku }}</code>
                                <span class="muted">{{ offer.productVariant.name }}</span>
                            </ng-container>
                            <span
                                *ngIf="!offer.product && !offer.collection && !offer.productVariant"
                                class="muted"
                                >Image only</span
                            >
                        </div>
                        <div class="card-actions">
                            <button
                                *ngIf="canUpdateOffer"
                                class="btn btn-sm"
                                [class.btn-live]="!offer.isPreview"
                                [class.btn-draft]="offer.isPreview"
                                (click)="togglePreviewStatus(offer)"
                            >
                                <clr-icon [attr.shape]="offer.isPreview ? 'eye-hide' : 'eye'"></clr-icon>
                                {{ offer.isPreview ? 'Set Draft' : 'Set Live' }}
                            </button>
                            <button
                                *ngIf="canUpdateOffer"
                                class="btn btn-sm btn-secondary"
                                (click)="editOffer(offer)"
                            >
                                <clr-icon shape="pencil"></clr-icon>
                            </button>
                            <button
                                *ngIf="canDeleteOffer"
                                class="btn btn-sm btn-danger"
                                (click)="deleteOffer(offer.id)"
                            >
                                <clr-icon shape="trash"></clr-icon>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </vdr-page-block>

        <div *ngIf="previewOffer" class="preview-backdrop" (click)="closePreview()">
            <div class="preview-panel" (click)="$event.stopPropagation()">
                <button class="preview-x" (click)="closePreview()">×</button>
                <div class="preview-image-wrap">
                    <img [src]="previewOffer.asset.source" />
                </div>
                <div class="preview-footer">
                    <div class="preview-info">
                        <span *ngIf="previewOffer.product" class="badge badge-product">Product: {{ previewOffer.product.name }}</span>
                        <span *ngIf="previewOffer.collection" class="badge badge-collection">Category: {{ previewOffer.collection.name }}</span>
                        <span *ngIf="previewOffer.productVariant" class="badge badge-variant">SKU: {{ previewOffer.productVariant.sku }}</span>
                        <span *ngIf="!previewOffer.product && !previewOffer.collection && !previewOffer.productVariant" class="badge badge-none">Image only</span>
                    </div>
                    <div class="preview-actions">
                        <button
                            class="btn"
                            [class.btn-success]="!previewOffer.isPreview"
                            [class.btn-warning]="previewOffer.isPreview"
                            (click)="togglePreviewStatus(previewOffer)"
                        >
                            <clr-icon [attr.shape]="previewOffer.isPreview ? 'eye-hide' : 'eye'"></clr-icon>
                            {{ previewOffer.isPreview ? 'Remove from Live' : 'Set as Live' }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `,
    styleUrls: ['./offer.component.css'],
    standalone: true,
    imports: [SharedModule, CommonModule, ReactiveFormsModule, FormsModule, RouterModule],
})
export class OfferComponent implements OnInit {
    offers: OfferRow[] = [];

    selectedAssetId: string | null = null;
    isPreviewMode = false;
    selectedAssetPreview: string | null = null;

    targetKind: TargetKind = 'product';
    targetSearchTerm = '';
    targetOptions: OptionRow[] = [];
    selectedTargetId: string | null = null;
    selectedTargetLabel: string | null = null;

    canCreateOffer = false;
    canUpdateOffer = false;
    canDeleteOffer = false;

    showCreateForm = false;
    editingOfferId: string | null = null;
    previewOffer: OfferRow | null = null;

    constructor(
        private apollo: Apollo,
        private dataService: DataService,
        private modalService: ModalService,
        private cdRef: ChangeDetectorRef,
    ) {}

    pickAsset() {
        this.modalService
            .fromComponent(AssetPickerDialogComponent, {
                size: 'xl',
                closable: true,
            })
            .subscribe(result => {
                if (result && result.length > 0) {
                    const asset = result[0];
                    this.selectedAssetId = asset.id;
                    this.selectedAssetPreview = (asset as any).source || asset.preview || null;
                    this.cdRef.detectChanges();
                }
            });
    }

    ngOnInit() {
        this.checkPermissions();
        this.fetchOffers();
    }

    get targetSearchLabel(): string {
        if (this.targetKind === 'product') return 'Search product by name';
        if (this.targetKind === 'collection') return 'Search collection (category) by name';
        return 'Search variant by name or SKU';
    }

    canSubmit(): boolean {
        // Image is required; link target is optional.
        return !!this.selectedAssetId;
    }

    setTargetKind(kind: TargetKind) {
        if (this.targetKind === kind) return;
        this.targetKind = kind;
        this.targetSearchTerm = '';
        this.targetOptions = [];
        this.selectedTargetId = null;
        this.selectedTargetLabel = null;
    }

    clearTarget() {
        this.selectedTargetId = null;
        this.selectedTargetLabel = null;
        this.targetSearchTerm = '';
        this.targetOptions = [];
    }

    toggleCreateForm() {
        if (this.showCreateForm) {
            this.closeForm();
        } else {
            this.editingOfferId = null;
            this.resetForm();
            this.showCreateForm = true;
        }
    }

    openPreview(offer: OfferRow) {
        this.previewOffer = offer;
    }

    closePreview() {
        this.previewOffer = null;
    }

    togglePreviewStatus(offer: OfferRow) {
        const newStatus = !offer.isPreview;
        const UPDATE_PREVIEW = gql`
            mutation UpdateOfferPreview($input: UpdateBannerPopupInput!) {
                updateBannerPopup(input: $input) { id isPreview }
            }
        `;
        this.apollo.mutate({
            mutation: UPDATE_PREVIEW,
            variables: { input: { id: offer.id, isPreview: newStatus } },
        }).subscribe({
            next: () => {
                offer.isPreview = newStatus;
                this.cdRef.detectChanges();
            },
            error: err => console.error('Failed to update preview status', err),
        });
    }

    onTargetSearchChange() {
        const term = this.targetSearchTerm.trim();
        if (!term) {
            this.targetOptions = [];
            return;
        }

        if (this.targetKind === 'product') {
            this.searchProducts(term);
        } else if (this.targetKind === 'collection') {
            this.searchCollections(term);
        } else {
            this.searchVariants(term);
        }
    }

    private searchProducts(term: string) {
        this.apollo
            .query<{ products: { items: Array<{ id: string; name: string }> } }>({
                query: gql`
                    query SearchProducts($term: String!) {
                        products(options: { take: 20, filter: { name: { contains: $term }, enabled: { eq: true } } }) {
                            items {
                                id
                                name
                            }
                        }
                    }
                `,
                variables: { term },
                fetchPolicy: 'no-cache',
            })
            .subscribe(res => {
                this.targetOptions = res.data.products.items.map(p => ({ id: p.id, label: p.name }));
                this.cdRef.detectChanges();
            });
    }

    private searchCollections(term: string) {
        this.apollo
            .query<{ collections: { items: Array<{ id: string; name: string }> } }>({
                query: gql`
                    query SearchCollections($term: String!) {
                        collections(options: { take: 20, filter: { name: { contains: $term }, isPrivate: { eq: false } } }) {
                            items {
                                id
                                name
                            }
                        }
                    }
                `,
                variables: { term },
                fetchPolicy: 'no-cache',
            })
            .subscribe(res => {
                this.targetOptions = res.data.collections.items.map(c => ({ id: c.id, label: c.name }));
                this.cdRef.detectChanges();
            });
    }

    private searchVariants(term: string) {
        const SEARCH_BY_NAME = gql`
            query SearchVariantsByName($term: String!) {
                productVariants(options: { take: 20, filter: { name: { contains: $term }, enabled: { eq: true } } }) {
                    items { id name sku }
                }
            }
        `;
        const SEARCH_BY_SKU = gql`
            query SearchVariantsBySku($term: String!) {
                productVariants(options: { take: 20, filter: { sku: { contains: $term }, enabled: { eq: true } } }) {
                    items { id name sku }
                }
            }
        `;

        // Run both queries in parallel and merge results (deduplicated by id)
        Promise.all([
            this.apollo.query<{ productVariants: { items: Array<{ id: string; name: string; sku: string }> } }>({
                query: SEARCH_BY_NAME, variables: { term }, fetchPolicy: 'no-cache',
            }).toPromise(),
            this.apollo.query<{ productVariants: { items: Array<{ id: string; name: string; sku: string }> } }>({
                query: SEARCH_BY_SKU, variables: { term }, fetchPolicy: 'no-cache',
            }).toPromise(),
        ]).then(([byName, bySku]) => {
            const map = new Map<string, { id: string; name: string; sku: string }>();
            for (const v of byName?.data?.productVariants?.items ?? []) map.set(v.id, v);
            for (const v of bySku?.data?.productVariants?.items ?? []) map.set(v.id, v);
            this.targetOptions = Array.from(map.values()).map(v => ({
                id: v.id,
                label: `${v.sku} — ${v.name}`,
            }));
            this.cdRef.detectChanges();
        });
    }

    selectTarget(opt: OptionRow) {
        this.selectedTargetId = opt.id;
        this.selectedTargetLabel = opt.label;
        this.targetOptions = [];
        this.targetSearchTerm = '';
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
                next: response => {
                    const permissions = response.me.channels?.[0]?.permissions || [];
                    this.canCreateOffer =
                        permissions.includes('CreateOffer') || permissions.includes('SuperAdmin');
                    this.canUpdateOffer =
                        permissions.includes('UpdateOffer') || permissions.includes('SuperAdmin');
                    this.canDeleteOffer =
                        permissions.includes('DeleteOffer') || permissions.includes('SuperAdmin');
                    this.cdRef.detectChanges();
                },
                error: err => console.error('Failed to fetch user permissions', err),
            });
    }

    fetchOffers() {
        this.apollo
            .watchQuery<{ allBannerPopup: { items: OfferRow[] } }>({
                query: GET_OFFERS,
                fetchPolicy: 'network-only',
            })
            .valueChanges.subscribe({
                next: result => {
                    this.offers = result.data.allBannerPopup.items;
                    this.cdRef.detectChanges();
                },
                error: err => console.error('Failed to fetch offers', err),
            });
    }

    onSubmit() {
        if (!this.canSubmit()) return;

        // For edit mode we explicitly clear all three target ids (null) so the
        // backend resets the existing link, then set the chosen one if any.
        const targetFields: any = this.editingOfferId
            ? { productId: null, collectionId: null, productVariantId: null }
            : {};
        if (this.selectedTargetId) {
            if (this.targetKind === 'product') targetFields.productId = this.selectedTargetId;
            if (this.targetKind === 'collection') targetFields.collectionId = this.selectedTargetId;
            if (this.targetKind === 'variant') targetFields.productVariantId = this.selectedTargetId;
        }

        if (this.editingOfferId) {
            const UPDATE_OFFER = gql`
                mutation UpdateBannerPopup($input: UpdateBannerPopupInput!) {
                    updateBannerPopup(input: $input) {
                        id
                    }
                }
            `;
            const input: any = { id: this.editingOfferId, assetId: this.selectedAssetId, isPreview: this.isPreviewMode, ...targetFields };
            this.apollo
                .mutate({ mutation: UPDATE_OFFER, variables: { input } })
                .subscribe({
                    next: () => {
                        this.closeForm();
                        this.fetchOffers();
                    },
                    error: err => console.error('Update offer failed', err),
                });
            return;
        }

        const CREATE_OFFER = gql`
            mutation CreateBannerPopup($input: CreateBannerPopupInput!) {
                createBannerPopup(input: $input) {
                    id
                }
            }
        `;
        const input: any = { assetId: this.selectedAssetId, isPreview: this.isPreviewMode, ...targetFields };
        this.apollo
            .mutate({ mutation: CREATE_OFFER, variables: { input } })
            .subscribe({
                next: () => {
                    this.closeForm();
                    this.fetchOffers();
                },
                error: err => console.error('Create offer failed', err),
            });
    }

    editOffer(offer: OfferRow) {
        this.editingOfferId = offer.id;
        this.showCreateForm = true;
        this.selectedAssetId = offer.asset.id;
        this.selectedAssetPreview = offer.asset.source;
        this.isPreviewMode = offer.isPreview;

        if (offer.product) {
            this.targetKind = 'product';
            this.selectedTargetId = offer.product.id;
            this.selectedTargetLabel = offer.product.name;
        } else if (offer.collection) {
            this.targetKind = 'collection';
            this.selectedTargetId = offer.collection.id;
            this.selectedTargetLabel = offer.collection.name;
        } else if (offer.productVariant) {
            this.targetKind = 'variant';
            this.selectedTargetId = offer.productVariant.id;
            this.selectedTargetLabel = `${offer.productVariant.sku} — ${offer.productVariant.name}`;
        } else {
            this.targetKind = 'product';
            this.selectedTargetId = null;
            this.selectedTargetLabel = null;
        }
        this.targetSearchTerm = '';
        this.targetOptions = [];
        this.cdRef.detectChanges();
    }

    private closeForm() {
        this.resetForm();
        this.showCreateForm = false;
        this.editingOfferId = null;
    }

    private resetForm() {
        this.selectedAssetId = null;
        this.selectedAssetPreview = null;
        this.targetSearchTerm = '';
        this.targetOptions = [];
        this.selectedTargetId = null;
        this.selectedTargetLabel = null;
        this.isPreviewMode = false;
    }

    deleteOffer(offerId: string) {
        const DELETE_OFFER = gql`
            mutation DeleteBannerPopup($id: ID!) {
                deleteBannerPopup(id: $id) {
                    result
                }
            }
        `;

        this.apollo
            .mutate({
                mutation: DELETE_OFFER,
                variables: { id: offerId },
            })
            .subscribe({
                next: () => this.fetchOffers(),
                error: err => console.error('Delete offer failed', err),
            });
    }
}

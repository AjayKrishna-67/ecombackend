import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SharedModule, ModalService, AssetPickerDialogComponent, NotificationService } from '@vendure/admin-ui/core';
import { Apollo } from 'apollo-angular';
import gql from 'graphql-tag';

type LaunchStatus = 'OPENING_SOON' | 'LAUNCHED';

const DEFAULT_SELLER_NAME = 'Default Seller';
const DEFAULT_CHANNEL_CODE = '__default_channel__';

interface BannerAsset {
    id: string;
    name: string;
    preview: string;
}

interface Row {
    sellerId: string;
    name: string;
    bannerAsset: BannerAsset | null;
    launchStatus: LaunchStatus;
    showInStoreSwitcher: boolean;
    sortOrder: number | null;
}

const GET_ACTIVE_CHANNEL = gql`
    query GetActiveAdminChannelBs {
        activeChannel {
            id
            code
            seller {
                id
            }
        }
    }
`;

const GET_BRAND_SELLERS = gql`
    query GetBrandSellersAdmin {
        sellers(options: { take: 500 }) {
            items {
                id
                name
            }
        }
    }
`;

const GET_BRAND_STOREFRONTS = gql`
    query GetBrandStorefrontsAdmin {
        brandStorefronts {
            id
            seller {
                id
            }
            bannerImage {
                id
                name
                preview
            }
            launchStatus
            showInStoreSwitcher
            sortOrder
        }
    }
`;

const UPSERT_BRAND_STOREFRONT = gql`
    mutation UpsertBrandStorefrontAdmin($input: UpsertBrandStorefrontInput!) {
        upsertBrandStorefront(input: $input) {
            id
        }
    }
`;

@Component({
    selector: 'brand-storefront-management',
    template: `
        <vdr-page-block>
            <h1 class="page-title">Brand Storefronts</h1>
            <p class="intro">
                Control which brands (sellers) appear in the app "Switch Store" sheet, their launch
                state, and banner image. A brand only shows in the app when "Show in switcher" is on.
            </p>

            <div *ngIf="rows.length === 0" class="empty-state">
                <p>No brand sellers. Create a Seller (one per brand) under Settings → Sellers.</p>
            </div>

            <div class="grid">
                <vdr-card *ngFor="let row of rows">
                    <div class="head">
                        <span class="code">{{ row.name }}</span>
                        <span class="badge" [class.launched]="row.launchStatus === 'LAUNCHED'">
                            {{ row.launchStatus === 'LAUNCHED' ? 'Launched' : 'Opening soon' }}
                        </span>
                    </div>

                    <div class="banner">
                        <img *ngIf="row.bannerAsset" [src]="row.bannerAsset.preview + '?preset=medium'" />
                        <span *ngIf="!row.bannerAsset" class="no-banner">No banner</span>
                    </div>

                    <div class="actions">
                        <button vdr-button (click)="pickAsset(row)">
                            {{ row.bannerAsset ? 'Change banner' : 'Pick banner' }}
                        </button>
                        <button vdr-button *ngIf="row.bannerAsset" (click)="row.bannerAsset = null">
                            Remove
                        </button>
                    </div>

                    <div class="fields">
                        <label>
                            <span>Launch status</span>
                            <select [(ngModel)]="row.launchStatus">
                                <option value="OPENING_SOON">Opening soon (locked)</option>
                                <option value="LAUNCHED">Launched (open)</option>
                            </select>
                        </label>
                        <label>
                            <span>Sort order</span>
                            <input type="number" [(ngModel)]="row.sortOrder" placeholder="—" />
                        </label>
                    </div>

                    <label class="checkbox">
                        <input type="checkbox" [(ngModel)]="row.showInStoreSwitcher" />
                        <span>Show in app switcher</span>
                    </label>

                    <div class="save">
                        <button vdr-button color="primary" [disabled]="saving" (click)="save(row)">Save</button>
                    </div>
                </vdr-card>
            </div>
        </vdr-page-block>
    `,
    styles: [`
        .page-title { font-size: 1.4rem; font-weight: 600; margin-bottom: 4px; }
        .intro { color: var(--color-text-300, #6c757d); font-size: 0.9rem; margin-bottom: 16px; max-width: 640px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 16px; }
        .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .code { font-weight: 600; }
        .badge { font-size: 0.75rem; padding: 2px 8px; border-radius: 10px; background: #e0e0e0; color: #555; }
        .badge.launched { background: #2073b5; color: #fff; }
        .banner { height: 160px; display: flex; align-items: center; justify-content: center; background: #f4f4f4; border-radius: 6px; overflow: hidden; margin-bottom: 10px; }
        .banner img { width: 100%; height: 100%; object-fit: cover; }
        .no-banner { color: #999; font-size: 0.85rem; }
        .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
        .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
        .fields label { display: flex; flex-direction: column; gap: 4px; font-size: 0.8rem; color: #6c757d; min-width: 0; }
        .fields select, .fields input { width: 100%; min-width: 0; box-sizing: border-box; padding: 6px 8px; border: 1px solid #ddd; border-radius: 4px; }
        .checkbox { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; margin-bottom: 12px; }
        .save { display: flex; justify-content: flex-end; border-top: 1px solid #eee; padding-top: 10px; }
        .empty-state { padding: 24px; text-align: center; color: #999; }
    `],
    standalone: true,
    imports: [SharedModule, CommonModule, FormsModule],
})
export class BrandStorefrontComponent implements OnInit {
    rows: Row[] = [];
    saving = false;

    constructor(
        private apollo: Apollo,
        private modalService: ModalService,
        private cdRef: ChangeDetectorRef,
        private notificationService: NotificationService,
    ) {}

    ngOnInit() {
        this.load();
    }

    load() {
        this.apollo
            .watchQuery<any>({ query: GET_ACTIVE_CHANNEL, fetchPolicy: 'network-only' })
            .valueChanges.subscribe(chRes => {
                const ch = chRes.data?.activeChannel;
                // Channel scope: default (super-admin) channel → all brands;
                // a brand's channel → only that brand's seller.
                const scopedSellerId =
                    ch && ch.code !== DEFAULT_CHANNEL_CODE && ch.seller ? String(ch.seller.id) : null;
                this.loadBrands(scopedSellerId);
            });
    }

    private loadBrands(scopedSellerId: string | null) {
        this.apollo
            .watchQuery<any>({ query: GET_BRAND_SELLERS, fetchPolicy: 'network-only' })
            .valueChanges.subscribe(sellerRes => {
                const allSellers: Array<{ id: string; name: string }> = sellerRes.data?.sellers?.items ?? [];
                let sellers = allSellers.filter(s => s.name !== DEFAULT_SELLER_NAME);
                if (scopedSellerId) {
                    sellers = sellers.filter(s => String(s.id) === scopedSellerId);
                }
                this.apollo
                    .watchQuery<any>({ query: GET_BRAND_STOREFRONTS, fetchPolicy: 'network-only' })
                    .valueChanges.subscribe(sfRes => {
                        const storefronts: any[] = sfRes.data?.brandStorefronts ?? [];
                        const bySeller = new Map(storefronts.map(s => [String(s.seller.id), s]));
                        this.rows = sellers.map(seller => {
                            const sf = bySeller.get(String(seller.id));
                            return {
                                sellerId: String(seller.id),
                                name: seller.name,
                                bannerAsset: sf?.bannerImage ?? null,
                                launchStatus: (sf?.launchStatus ?? 'OPENING_SOON') as LaunchStatus,
                                showInStoreSwitcher: sf?.showInStoreSwitcher ?? false,
                                sortOrder: sf?.sortOrder ?? null,
                            };
                        });
                        this.cdRef.detectChanges();
                    });
            });
    }

    pickAsset(row: Row) {
        this.modalService
            .fromComponent(AssetPickerDialogComponent, { size: 'xl', closable: true })
            .subscribe(result => {
                if (result && result.length > 0) {
                    const asset = result[0] as any;
                    row.bannerAsset = { id: asset.id, name: asset.name, preview: asset.preview };
                    this.cdRef.detectChanges();
                }
            });
    }

    save(row: Row) {
        this.saving = true;
        this.apollo
            .mutate({
                mutation: UPSERT_BRAND_STOREFRONT,
                variables: {
                    input: {
                        sellerId: row.sellerId,
                        bannerImageId: row.bannerAsset ? row.bannerAsset.id : null,
                        launchStatus: row.launchStatus,
                        showInStoreSwitcher: row.showInStoreSwitcher,
                        sortOrder: row.sortOrder === null || (row.sortOrder as any) === '' ? null : Number(row.sortOrder),
                    },
                },
            })
            .subscribe({
                next: () => {
                    this.saving = false;
                    this.notificationService.success('Storefront saved');
                    this.cdRef.detectChanges();
                },
                error: (err: any) => {
                    this.saving = false;
                    this.notificationService.error('Save failed');
                    console.error('Save failed', err);
                },
            });
    }
}

import { Component, OnInit } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { SharedModule, ModalService, AssetPickerDialogComponent } from '@vendure/admin-ui/core';
import { Apollo } from 'apollo-angular';
import gql from 'graphql-tag';
import { CommonModule } from '@angular/common';
import { DataService } from '@vendure/admin-ui/core';
import { RouterModule } from '@angular/router';
import { ChangeDetectorRef } from '@angular/core';



const GET_BANNERS = gql`
  query GetBanners {
    customBanners {
      items {
        id
        assets {
          id
          source
        }
        channels {
          id
        }
      }
    }
  }
`;

@Component({
  selector: 'banner-management',
  template: `
 <vdr-page-block>
  <div class="content-tabs">
    <a class="content-tab active">Banners</a>
    <a class="content-tab" routerLink="/extensions/offer">Offers</a>
  </div>

  <!-- Upload Banner Section -->
    <vdr-card *ngIf="canCreateBanner">
      <div class="upload-section">
        <button vdr-button type="button" (click)="pickAsset()">
          {{ selectedAssetPreview ? 'Change image' : 'Pick from assets' }}
        </button>
        <div *ngIf="selectedAssetPreview" class="asset-preview">
          <img [src]="selectedAssetPreview" />
        </div>
        <button vdr-button
          type="submit"
          color="primary"
          [disabled]="!selectedAssetId"
          (click)="onSubmit()"
          class="custom-upload-btn">
          Upload Banner
        </button>
      </div>
    </vdr-card>

  <!-- Display Banners in a Grid -->
  <div class="banner-grid">
    <div *ngIf="banners.length === 0" class="empty-state">
      <p>No banners available. Create one to get started!</p>
    </div>

    <div *ngFor="let banner of banners" class="banner-card">
      <div class="banner-image">
        <img *ngIf="banner.assets.length > 0" [src]="banner.assets[0].source" class="image" />
      </div>

      <div class="banner-info">
        
        <div class="banner-actions">
          <button *ngIf="canUpdateBanner" class="action-btn update-btn" (click)="pickAssetForUpdate(banner.id)">Update Image</button>
          <button *ngIf="canDeleteBanner" class="action-btn delete-btn" (click)="deleteBanner(banner.id)">Delete</button>
        </div>
      </div>
    </div>
  </div>
</vdr-page-block>

  `,
  styles: [`

  
  .content-tabs {
    display: flex;
    gap: 0;
    margin-bottom: 20px;
    border-bottom: 2px solid var(--color-component-border-200, #ddd);
  }
  .content-tab {
    padding: 10px 24px;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
    color: var(--color-text-300, #6c757d);
    text-decoration: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    transition: color 0.15s, border-color 0.15s;
  }
  .content-tab:hover {
    color: var(--color-primary-500, #2073b5);
  }
  .content-tab.active {
    color: var(--color-primary-500, #2073b5);
    border-bottom-color: var(--color-primary-500, #2073b5);
    font-weight: 600;
  }

  /* Upload Section - Responsive */
  .upload-section {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: 12px;
    padding: 16px;
  }
  .asset-preview img {
    max-width: 240px;
    max-height: 140px;
    border-radius: 6px;
    border: 1px solid #ddd;
    margin-top: 8px;
  }

/* Custom button styling */
.custom-upload-btn {
    padding: 12px 24px;
    background: linear-gradient(45deg, #4caf50, #45a049);
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 16px;
    font-weight: bold;
    cursor: pointer;
    transition: background 0.3s, transform 0.3s;
    text-transform: uppercase;
}

/* Hover effect */
.custom-upload-btn:hover {
    background: linear-gradient(45deg, #45a049, #4caf50);
    transform: scale(1.05);
}

/* Disabled state styling */
.custom-upload-btn[disabled] {
    background: #d3d3d3;
    cursor: not-allowed;
}


.banner-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 16px;
  padding: 16px;
}

.banner-card {
  background-color: white;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  overflow: hidden;
  text-align: center;
  transition: transform 0.3s ease-in-out;
  padding: 16px;
}

.banner-card:hover {
  transform: translateY(-8px);
}

.banner-image {
  width: 100%;
  height: 200px;
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: #f4f4f4;
  border-radius: 6px;
  overflow: hidden;
}

.banner-image img {
  width: 100%;
  height: auto;
  object-fit: cover;
}

.banner-info {
  margin-top: 12px;
}

.banner-actions {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.action-btn {
  padding: 8px 12px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: 0.3s;
}

.update-btn {
  background-color: #007bff;
  color: white;
}

.update-btn:hover {
  background-color: #0056b3;
}

.delete-btn {
  background-color: #ff4d4d;
  color: white;
}

.delete-btn:hover {
  background-color: #cc0000;
}

.empty-state {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 20px;
  
  border-radius: 8px;
}

  `],
  standalone: true,
  imports: [SharedModule, CommonModule, ReactiveFormsModule, RouterModule],
})
export class BannerComponent implements OnInit {
  banners: Array<{ id: string, assets: { source: string }[], channels: { id: string }[] }> = [];
  selectedAssetId: string | null = null;
  selectedAssetPreview: string | null = null;
  currentChannelId: string | null = null;
  
  // Permission flags
  canCreateBanner = false;
  canUpdateBanner = false;
  canDeleteBanner = false;

  constructor(
    private apollo: Apollo,
    private dataService: DataService,
    private modalService: ModalService,
    private cdRef: ChangeDetectorRef,
  ) {}

  ngOnInit() {
    this.checkPermissions();
    this.fetchActiveChannel();
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
        `
      )
      .single$.subscribe({
        next: (response) => {
          // Get permissions from the current channel (usually the first one)
          const permissions = response.me.channels?.[0]?.permissions || [];
          this.canCreateBanner = permissions.includes('CreateBanner') || permissions.includes('SuperAdmin');
          this.canUpdateBanner = permissions.includes('UpdateBanner') || permissions.includes('SuperAdmin');
          this.canDeleteBanner = permissions.includes('DeleteBanner') || permissions.includes('SuperAdmin');
          this.cdRef.detectChanges();
        },
        error: (err) => console.error('Failed to fetch user permissions', err),
      });
  }

  fetchActiveChannel() {
    this.dataService
      .query<{ activeChannel: { id: string } }>(
        gql`
          query GetActiveChannel {
            activeChannel {
              id
            }
          }
        `
      )
      .single$.subscribe({
        next: (response) => {
          this.currentChannelId = response.activeChannel.id;
          console.log("Active Channel ID:", this.currentChannelId);
          this.fetchBanners();
        },
        error: (err) => console.error('Failed to fetch active channel', err),
      });
  }

  fetchBanners() {
    if (!this.currentChannelId) return;

    const GET_BANNERS = gql`
  query GetBanners {
    customBanners {
      items {
        id
        assets {
          id
          source
        }
        channels {
          id
        }
      }
    }
  }
`;


    this.apollo
      .watchQuery<{ customBanners: { items: any[] } }>({
        query: GET_BANNERS,
          fetchPolicy: 'network-only'
      })
      .valueChanges.subscribe({
        next: (result) => {
          console.log("Fetched Banners:", result.data.customBanners.items);
          this.banners = result.data.customBanners.items.filter(banner => 
            banner.channels.some(channel => channel.id === this.currentChannelId)
          );
          this.cdRef.detectChanges(); 
          console.log("Filtered Banners:", this.banners);
        },
        error: (err) => console.error('Failed to fetch banners', err),
      });
  }

  pickAsset() {
    this.modalService
      .fromComponent(AssetPickerDialogComponent, { size: 'xl', closable: true })
      .subscribe(result => {
        if (result && result.length > 0) {
          const asset = result[0];
          this.selectedAssetId = asset.id;
          this.selectedAssetPreview = (asset as any).source || asset.preview || null;
          this.cdRef.detectChanges();
        }
      });
  }
  

  onSubmit() {
    if (!this.selectedAssetId) return;
    this.createBanner(this.selectedAssetId);
    this.selectedAssetId = null;
    this.selectedAssetPreview = null;
  }

  createBanner(assetId: string) {
    if (!this.currentChannelId) return;

    const CREATE_BANNER = gql`
      mutation CreateCustomBanner($input: CreateCustomBannerInput!) {
        createCustomBanner(input: $input) { id assets { source } }
      }
    `;

  

    this.apollo.mutate({
      mutation: CREATE_BANNER,
      variables: { input: { assetIds: [assetId] } },
      refetchQueries: [{ query: GET_BANNERS }]
    }).subscribe({
      next: () => {
        console.log("Banner created successfully");
      },
      error: (err) => console.error("Create banner failed", err),
    });
    
    
  }

  pickAssetForUpdate(bannerId: string) {
    this.modalService
      .fromComponent(AssetPickerDialogComponent, { size: 'xl', closable: true })
      .subscribe(result => {
        if (result && result.length > 0) {
          this.updateBanner(bannerId, result[0].id);
        }
      });
  }

  updateBanner(bannerId: string, assetId: string) {
    const UPDATE_BANNER = gql`
      mutation UpdateCustomBanner($input: UpdateCustomBannerInput!) {
        updateCustomBanner(input: $input) {
          id
          assets { source }
        }
      }
    `;
  
    this.apollo.mutate({
      mutation: UPDATE_BANNER,
      variables: { input: { id: bannerId, assetIds: [assetId] } }, // Include id inside input
    }).subscribe({
      next: () => {
        console.log("Banner updated successfully");
        this.fetchBanners();  // Refresh banners after update
        this.cdRef.detectChanges();
      },
      error: (err) => console.error("Update banner failed", err),
    });
  }
  
  
  

  deleteBanner(bannerId: string) {
    const DELETE_BANNER = gql`
      mutation DeleteCustomBanner($id: ID!) {
        deleteCustomBanner(id: $id) { result }
      }
    `;

    this.apollo.mutate({
      mutation: DELETE_BANNER,
      variables: { id: bannerId },
      refetchQueries: [{ query: GET_BANNERS }]
    }).subscribe({
      next: () => {
        this.fetchBanners();  // Refresh banners after deletion
        console.log("Banner deleted successfully");
      },
      error: (err) => console.error("Delete banner failed", err)
    });
  }
}

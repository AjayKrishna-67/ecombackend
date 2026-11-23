import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit, OnDestroy } from '@angular/core';
import { AbstractControl, FormBuilder, FormGroup, ValidationErrors, ValidatorFn, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
    NotificationService,
    SharedModule,
    ModalService,
    DataService,
    AssetPickerDialogComponent,
} from '@vendure/admin-ui/core';
import { Apollo } from 'apollo-angular';
import gql from 'graphql-tag';
import { Subject, of } from 'rxjs';
import { map, switchMap, takeUntil } from 'rxjs/operators';

const ADDON_GROUP_FRAGMENT = gql`
    fragment AddonGroupFields on AddonGroup {
        id
        createdAt
        updatedAt
        name
        description
        selectionType
        isRequired
        minSelections
        maxSelections
        sortOrder
        enabled
        items {
            id
            createdAt
            name
            price
            sku
            isDefault
            minQuantity
            maxQuantity
            sortOrder
            enabled
            image {
                id
                preview
            }
        }
    }
`;

const GET_ADDON_GROUP = gql`
    query GetAddonGroup($id: ID!) {
        addonGroup(id: $id) {
            ...AddonGroupFields
        }
    }
    ${ADDON_GROUP_FRAGMENT}
`;

const CREATE_ADDON_GROUP = gql`
    mutation CreateAddonGroup($input: CreateAddonGroupInput!) {
        createAddonGroup(input: $input) {
            ...AddonGroupFields
        }
    }
    ${ADDON_GROUP_FRAGMENT}
`;

const UPDATE_ADDON_GROUP = gql`
    mutation UpdateAddonGroup($input: UpdateAddonGroupInput!) {
        updateAddonGroup(input: $input) {
            ...AddonGroupFields
        }
    }
    ${ADDON_GROUP_FRAGMENT}
`;

const CREATE_ADDON_ITEM = gql`
    mutation CreateAddonItem($input: CreateAddonItemInput!) {
        createAddonItem(input: $input) {
            id name price sku isDefault minQuantity maxQuantity sortOrder enabled
            image { id preview }
        }
    }
`;

const UPDATE_ADDON_ITEM = gql`
    mutation UpdateAddonItem($input: UpdateAddonItemInput!) {
        updateAddonItem(input: $input) {
            id name price sku isDefault minQuantity maxQuantity sortOrder enabled
            image { id preview }
        }
    }
`;

const DELETE_ADDON_ITEM = gql`
    mutation DeleteAddonItem($id: ID!) {
        deleteAddonItem(id: $id) {
            result
            message
        }
    }
`;

const GET_ASSIGNED_VARIANTS = gql`
    query GetVariantsWithAddonGroup($addonGroupId: ID!) {
        variantsWithAddonGroup(addonGroupId: $addonGroupId) {
            id
            name
            sku
            productId
            productName
        }
    }
`;

interface AssignedVariant {
    id: string;
    name: string;
    sku: string;
    productId: string;
    productName: string;
}

const groupCrossValidator: ValidatorFn = (group: AbstractControl): ValidationErrors | null => {
    const min = Number(group.get('minSelections')?.value);
    const max = Number(group.get('maxSelections')?.value);
    const required = !!group.get('isRequired')?.value;
    const errors: ValidationErrors = {};
    if (!Number.isNaN(min) && !Number.isNaN(max) && min > max) {
        errors['minGtMaxSelections'] = true;
    }
    if (required && (Number.isNaN(min) || min < 1)) {
        errors['requiredNeedsMinOne'] = true;
    }
    return Object.keys(errors).length ? errors : null;
};

const itemCrossValidator: ValidatorFn = (group: AbstractControl): ValidationErrors | null => {
    const min = Number(group.get('minQuantity')?.value);
    const max = Number(group.get('maxQuantity')?.value);
    if (!Number.isNaN(min) && !Number.isNaN(max) && min > max) {
        return { minGtMaxQuantity: true };
    }
    return null;
};

interface AddonItemImage {
    id: string;
    preview: string;
}

interface AddonItemData {
    id: string;
    name: string;
    price: number;
    sku: string;
    isDefault: boolean;
    minQuantity: number;
    maxQuantity: number;
    sortOrder: number;
    enabled: boolean;
    image: AddonItemImage | null;
}

interface AddonGroupData {
    id: string;
    createdAt: string;
    updatedAt: string;
    name: string;
    description: string;
    selectionType: string;
    isRequired: boolean;
    minSelections: number;
    maxSelections: number;
    sortOrder: number;
    enabled: boolean;
    items: AddonItemData[];
}

@Component({
    selector: 'addon-group-detail',
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
                    <vdr-card *ngIf="!isNew" title="How to assign">
                        <p class="help-text">
                            To assign this addon group to product variants, go to the
                            product detail page and select it under the "Addon Groups" tab
                            on each variant.
                        </p>
                    </vdr-card>
                </vdr-page-detail-sidebar>

                <vdr-page-block>
                    <!-- Group Settings -->
                    <vdr-card [title]="isNew ? 'Create Addon Group' : 'Edit Addon Group'">
                        <div class="form-grid">
                            <vdr-form-field label="Name" for="name">
                                <input id="name" type="text" formControlName="name" />
                                <div class="field-error" *ngIf="detailForm.get('name')?.touched && detailForm.get('name')?.errors?.['required']">
                                    Name is required
                                </div>
                                <div class="field-error" *ngIf="detailForm.get('name')?.touched && detailForm.get('name')?.errors?.['maxlength']">
                                    Name is too long (max 255 characters)
                                </div>
                            </vdr-form-field>
                            <vdr-form-field label="Description" for="description">
                                <textarea id="description" formControlName="description" rows="2"></textarea>
                            </vdr-form-field>
                            <div class="form-row">
                                <vdr-form-field label="Selection Type" for="selectionType">
                                    <select id="selectionType" formControlName="selectionType">
                                        <option value="CHECKBOX">Checkbox (toggle on/off)</option>
                                        <option value="QUANTITY">Quantity (with min/max count)</option>
                                    </select>
                                </vdr-form-field>
                                <vdr-form-field label="Required" for="isRequired">
                                    <input id="isRequired" type="checkbox" formControlName="isRequired" clrToggle />
                                </vdr-form-field>
                            </div>
                            <div class="form-row">
                                <vdr-form-field label="Min Selections" for="minSelections">
                                    <input id="minSelections" type="number" formControlName="minSelections" min="0" />
                                    <div class="field-error" *ngIf="detailForm.get('minSelections')?.touched && detailForm.get('minSelections')?.errors?.['required']">
                                        Min selections is required
                                    </div>
                                    <div class="field-error" *ngIf="detailForm.get('minSelections')?.touched && detailForm.get('minSelections')?.errors?.['min']">
                                        Min selections cannot be negative
                                    </div>
                                </vdr-form-field>
                                <vdr-form-field label="Max Selections" for="maxSelections">
                                    <input id="maxSelections" type="number" formControlName="maxSelections" min="1" />
                                    <div class="field-error" *ngIf="detailForm.get('maxSelections')?.touched && detailForm.get('maxSelections')?.errors?.['required']">
                                        Max selections is required
                                    </div>
                                    <div class="field-error" *ngIf="detailForm.get('maxSelections')?.touched && detailForm.get('maxSelections')?.errors?.['min']">
                                        Max selections must be at least 1
                                    </div>
                                </vdr-form-field>
                            </div>
                            <div class="field-error" *ngIf="detailForm.errors?.['minGtMaxSelections'] && (detailForm.get('minSelections')?.touched || detailForm.get('maxSelections')?.touched)">
                                Min selections cannot be greater than max selections
                            </div>
                            <div class="field-error" *ngIf="detailForm.errors?.['requiredNeedsMinOne'] && (detailForm.get('isRequired')?.touched || detailForm.get('minSelections')?.touched)">
                                Required groups must have min selections of at least 1
                            </div>
                            <div class="form-row">
                                <vdr-form-field label="Sort Order" for="sortOrder">
                                    <input id="sortOrder" type="number" formControlName="sortOrder" />
                                    <div class="field-error" *ngIf="detailForm.get('sortOrder')?.touched && detailForm.get('sortOrder')?.errors?.['required']">
                                        Sort order is required
                                    </div>
                                    <div class="field-error" *ngIf="detailForm.get('sortOrder')?.touched && detailForm.get('sortOrder')?.errors?.['min']">
                                        Sort order cannot be negative
                                    </div>
                                </vdr-form-field>
                                <vdr-form-field label="Enabled" for="enabled">
                                    <input id="enabled" type="checkbox" formControlName="enabled" clrToggle />
                                </vdr-form-field>
                            </div>
                        </div>
                    </vdr-card>

                    <!-- Addon Items (only when editing existing group) -->
                    <vdr-card *ngIf="!isNew" title="Addon Items">
                        <div class="items-header">
                            <span class="items-count">{{ entity?.items?.length || 0 }} items</span>
                            <button class="btn btn-sm btn-secondary" (click)="showAddItem = !showAddItem">
                                <clr-icon shape="plus" size="14"></clr-icon>
                                Add Item
                            </button>
                        </div>

                        <!-- Add Item Form -->
                        <div class="add-item-form" *ngIf="showAddItem">
                            <form [formGroup]="itemForm" class="item-form-grid">
                                <vdr-form-field label="Name" for="itemName">
                                    <input id="itemName" type="text" formControlName="name" placeholder="e.g., Gift Wrap" />
                                    <div class="field-error" *ngIf="itemForm.get('name')?.touched && itemForm.get('name')?.errors?.['required']">
                                        Name is required
                                    </div>
                                    <div class="field-error" *ngIf="itemForm.get('name')?.touched && itemForm.get('name')?.errors?.['maxlength']">
                                        Name is too long (max 255 characters)
                                    </div>
                                </vdr-form-field>
                                <vdr-form-field label="Price" for="itemPrice">
                                    <input id="itemPrice" type="number" formControlName="price" min="0" step="0.01" />
                                    <div class="field-error" *ngIf="itemForm.get('price')?.touched && itemForm.get('price')?.errors?.['required']">
                                        Price is required
                                    </div>
                                    <div class="field-error" *ngIf="itemForm.get('price')?.touched && itemForm.get('price')?.errors?.['min']">
                                        Price cannot be negative
                                    </div>
                                </vdr-form-field>
                                <vdr-form-field label="SKU" for="itemSku">
                                    <input id="itemSku" type="text" formControlName="sku" placeholder="Optional" />
                                    <div class="field-error" *ngIf="itemForm.get('sku')?.touched && itemForm.get('sku')?.errors?.['maxlength']">
                                        SKU is too long (max 255 characters)
                                    </div>
                                </vdr-form-field>
                                <vdr-form-field *ngIf="!isCheckbox" label="Min Qty" for="itemMinQty">
                                    <input id="itemMinQty" type="number" formControlName="minQuantity" min="0" />
                                    <div class="field-error" *ngIf="itemForm.get('minQuantity')?.touched && itemForm.get('minQuantity')?.errors?.['required']">
                                        Min quantity is required
                                    </div>
                                    <div class="field-error" *ngIf="itemForm.get('minQuantity')?.touched && itemForm.get('minQuantity')?.errors?.['min']">
                                        Min quantity cannot be negative
                                    </div>
                                </vdr-form-field>
                                <vdr-form-field *ngIf="!isCheckbox" label="Max Qty" for="itemMaxQty">
                                    <input id="itemMaxQty" type="number" formControlName="maxQuantity" min="1" />
                                    <div class="field-error" *ngIf="itemForm.get('maxQuantity')?.touched && itemForm.get('maxQuantity')?.errors?.['required']">
                                        Max quantity is required
                                    </div>
                                    <div class="field-error" *ngIf="itemForm.get('maxQuantity')?.touched && itemForm.get('maxQuantity')?.errors?.['min']">
                                        Max quantity must be at least 1
                                    </div>
                                </vdr-form-field>
                                <div *ngIf="!isCheckbox && itemForm.errors?.['minGtMaxQuantity'] && (itemForm.get('minQuantity')?.touched || itemForm.get('maxQuantity')?.touched)" class="field-error" style="grid-column: 1 / -1;">
                                    Min quantity cannot be greater than max quantity
                                </div>
                                <div *ngIf="isCheckbox" class="checkbox-hint" style="grid-column: 1 / -1;">
                                    Quantity is fixed to 1 for checkbox-type groups.
                                </div>
                                <div class="image-picker-row">
                                    <label class="image-label">Image</label>
                                    <div class="image-preview-wrap">
                                        <img *ngIf="newItemImagePreview" [src]="newItemImagePreview" class="image-thumb" />
                                        <button class="btn btn-sm btn-outline" type="button" (click)="pickNewItemImage()">
                                            {{ newItemImageId ? 'Change' : 'Select' }} Image
                                        </button>
                                        <button *ngIf="newItemImageId" class="btn btn-sm btn-outline-danger" type="button" (click)="clearNewItemImage()">
                                            Remove
                                        </button>
                                    </div>
                                </div>
                                <div class="item-form-actions">
                                    <button class="btn btn-primary btn-sm" (click)="addItem()" [disabled]="itemForm.invalid">
                                        Save Item
                                    </button>
                                    <button class="btn btn-sm" (click)="showAddItem = false">Cancel</button>
                                </div>
                            </form>
                        </div>

                        <!-- Items Table -->
                        <table class="items-table" *ngIf="entity?.items?.length">
                            <thead>
                                <tr>
                                    <th>Image</th>
                                    <th>Name</th>
                                    <th>Price</th>
                                    <th>SKU</th>
                                    <th>Min Qty</th>
                                    <th>Max Qty</th>
                                    <th>Sort Order</th>
                                    <th>Status</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr *ngFor="let item of entity?.items" class="item-row">
                                    <td>
                                        <ng-container *ngIf="editingItemId !== item.id">
                                            <img *ngIf="item.image?.preview" [src]="item.image.preview + '?preset=tiny'" class="image-thumb" />
                                            <span *ngIf="!item.image?.preview" class="no-image">-</span>
                                        </ng-container>
                                        <div *ngIf="editingItemId === item.id" class="edit-image-wrap">
                                            <img *ngIf="editItemData.image?.preview" [src]="editItemData.image.preview + '?preset=tiny'" class="image-thumb" />
                                            <button class="action-btn edit" type="button" (click)="pickEditItemImage()" title="Change image">
                                                <clr-icon shape="image" size="14"></clr-icon>
                                            </button>
                                            <button *ngIf="editItemData.image" class="action-btn delete" type="button" (click)="editItemData.image = null; editItemData.imageId = null" title="Remove image">
                                                <clr-icon shape="times" size="14"></clr-icon>
                                            </button>
                                        </div>
                                    </td>
                                    <td>
                                        <ng-container *ngIf="editingItemId !== item.id">{{ item.name }}</ng-container>
                                        <input *ngIf="editingItemId === item.id" type="text" [(ngModel)]="editItemData.name" [ngModelOptions]="{standalone: true}" class="inline-input" />
                                    </td>
                                    <td>
                                        <ng-container *ngIf="editingItemId !== item.id">{{ item.price / 100 | currency:currencyCode }}</ng-container>
                                        <input *ngIf="editingItemId === item.id" type="number" [(ngModel)]="editItemData.price" [ngModelOptions]="{standalone: true}" class="inline-input narrow" />
                                    </td>
                                    <td>
                                        <ng-container *ngIf="editingItemId !== item.id">{{ item.sku || '-' }}</ng-container>
                                        <input *ngIf="editingItemId === item.id" type="text" [(ngModel)]="editItemData.sku" [ngModelOptions]="{standalone: true}" class="inline-input" />
                                    </td>
                                    <td>
                                        <ng-container *ngIf="editingItemId !== item.id">{{ item.minQuantity }}</ng-container>
                                        <input *ngIf="editingItemId === item.id" type="number" min="0" [(ngModel)]="editItemData.minQuantity" [ngModelOptions]="{standalone: true}" class="inline-input narrow" [disabled]="isCheckbox" />
                                    </td>
                                    <td>
                                        <ng-container *ngIf="editingItemId !== item.id">{{ item.maxQuantity }}</ng-container>
                                        <input *ngIf="editingItemId === item.id" type="number" min="1" [(ngModel)]="editItemData.maxQuantity" [ngModelOptions]="{standalone: true}" class="inline-input narrow" [disabled]="isCheckbox" />
                                    </td>
                                    <td>
                                        <ng-container *ngIf="editingItemId !== item.id">{{ item.sortOrder }}</ng-container>
                                        <input *ngIf="editingItemId === item.id" type="number" min="0" [(ngModel)]="editItemData.sortOrder" [ngModelOptions]="{standalone: true}" class="inline-input narrow" />
                                    </td>
                                    <td>
                                        <ng-container *ngIf="editingItemId !== item.id">
                                            <span class="status-dot" [class.active]="item.enabled" [class.inactive]="!item.enabled"></span>
                                        </ng-container>
                                        <input *ngIf="editingItemId === item.id" type="checkbox" [(ngModel)]="editItemData.enabled" [ngModelOptions]="{standalone: true}" />
                                    </td>
                                    <td>
                                        <div class="action-buttons" *ngIf="editingItemId !== item.id">
                                            <button class="action-btn edit" (click)="startEditItem(item)" title="Edit">
                                                <clr-icon shape="pencil" size="14"></clr-icon>
                                            </button>
                                            <button class="action-btn delete" (click)="deleteItem(item)" title="Delete">
                                                <clr-icon shape="trash" size="14"></clr-icon>
                                            </button>
                                        </div>
                                        <div class="action-buttons" *ngIf="editingItemId === item.id">
                                            <button class="action-btn save" (click)="saveEditItem()" title="Save">
                                                <clr-icon shape="check" size="14"></clr-icon>
                                            </button>
                                            <button class="action-btn cancel" (click)="cancelEditItem()" title="Cancel">
                                                <clr-icon shape="times" size="14"></clr-icon>
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            </tbody>
                        </table>

                        <div class="empty-items" *ngIf="!entity?.items?.length">
                            <p>No addon items yet. Add items that customers can select.</p>
                        </div>
                    </vdr-card>

                    <!-- Assigned Products/Variants -->
                    <vdr-card *ngIf="!isNew" title="Assigned Products">
                        <div class="items-header">
                            <span class="items-count">{{ assignedVariants.length }} variant{{ assignedVariants.length !== 1 ? 's' : '' }}</span>
                        </div>
                        <table class="items-table" *ngIf="assignedVariants.length > 0">
                            <thead>
                                <tr>
                                    <th>Product</th>
                                    <th>Variant</th>
                                    <th>SKU</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr *ngFor="let v of assignedVariants" class="item-row">
                                    <td><strong>{{ v.productName }}</strong></td>
                                    <td>{{ v.name }}</td>
                                    <td>{{ v.sku || '-' }}</td>
                                    <td>
                                        <a class="action-btn edit" [routerLink]="['/catalog', 'products', v.productId]" title="Go to product">
                                            <clr-icon shape="pop-out" size="14"></clr-icon>
                                        </a>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                        <div class="empty-items" *ngIf="assignedVariants.length === 0">
                            <p>No products assigned yet. Assign this group from a product variant's "Addon Groups" tab.</p>
                        </div>
                    </vdr-card>
                </vdr-page-block>
            </vdr-page-detail-layout>
        </form>
    `,
    styles: [`
        .form-grid { display: flex; flex-direction: column; gap: 16px; }
        .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .help-text { font-size: 13px; color: var(--color-text-300); line-height: 1.5; margin: 0; }

        .items-header {
            display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;
        }
        .items-count { font-size: 14px; color: var(--color-text-300); font-weight: 500; }
        .add-item-form {
            background: var(--color-component-bg-200); padding: 16px; border-radius: 8px; margin-bottom: 16px;
        }
        .item-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .item-form-actions { grid-column: 1 / -1; display: flex; gap: 8px; justify-content: flex-end; }

        .image-picker-row { grid-column: 1 / -1; }
        .image-label { display: block; font-size: 12px; font-weight: 600; color: var(--color-text-300); margin-bottom: 4px; }
        .image-preview-wrap { display: flex; align-items: center; gap: 8px; }
        .image-thumb { width: 40px; height: 40px; object-fit: cover; border-radius: 4px; border: 1px solid var(--color-component-border-100); }
        .no-image { color: var(--color-text-300); }
        .edit-image-wrap { display: flex; align-items: center; gap: 4px; }
        .btn-outline { border: 1px solid var(--color-component-border-200); background: none; cursor: pointer; border-radius: 4px; padding: 4px 8px; font-size: 12px; }
        .btn-outline-danger { border: 1px solid #ef4444; color: #ef4444; background: none; cursor: pointer; border-radius: 4px; padding: 4px 8px; font-size: 12px; }

        .items-table { width: 100%; border-collapse: collapse; }
        .items-table th {
            text-align: left; padding: 8px 12px; font-size: 11px; font-weight: 600;
            text-transform: uppercase; color: var(--color-text-300);
            border-bottom: 2px solid var(--color-component-border-100);
        }
        .items-table td {
            padding: 10px 12px; border-bottom: 1px solid var(--color-component-border-100);
            font-size: 13px; vertical-align: middle;
        }
        .item-row:hover { background: var(--color-component-bg-200); }
        .inline-input {
            padding: 4px 8px; border: 1px solid var(--color-component-border-100);
            border-radius: 4px; font-size: 13px; width: 100%;
            background: var(--color-component-bg-100);
        }
        .inline-input.narrow { width: 70px; }
        .text-success { color: #10b981; }
        .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
        .status-dot.active { background: #10b981; }
        .status-dot.inactive { background: #ef4444; }
        .action-buttons { display: flex; gap: 4px; }
        .action-btn {
            width: 26px; height: 26px; border: none; background: var(--color-component-bg-300);
            cursor: pointer; border-radius: 4px; display: inline-flex;
            align-items: center; justify-content: center; transition: all 0.2s;
            color: var(--color-text-300);
        }
        .action-btn.edit:hover, .action-btn.save:hover { background: var(--color-primary-500); color: white; }
        .action-btn.delete:hover { background: #ef4444; color: white; }
        .action-btn.cancel:hover { background: var(--color-text-300); color: white; }
        .empty-items { text-align: center; padding: 32px; color: var(--color-text-300); }
        .field-error {
            display: block; width: 100%; flex-basis: 100%;
            color: #ef4444; font-size: 12px; margin-top: 4px; line-height: 1.3;
        }
        .checkbox-hint { font-size: 12px; color: var(--color-text-300); font-style: italic; }
    `],
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: true,
    imports: [SharedModule],
})
export class AddonGroupDetailComponent implements OnInit, OnDestroy {
    entity: AddonGroupData | null = null;
    isNew = true;
    detailForm: FormGroup;
    itemForm: FormGroup;
    showAddItem = false;
    editingItemId: string | null = null;
    editItemData: Partial<AddonItemData> & { imageId?: string | null } = {};
    currencyCode = 'USD';
    newItemImageId: string | null = null;
    newItemImagePreview: string | null = null;
    assignedVariants: AssignedVariant[] = [];
    private destroy$ = new Subject<void>();

    constructor(
        private apollo: Apollo,
        private formBuilder: FormBuilder,
        private route: ActivatedRoute,
        private router: Router,
        private notificationService: NotificationService,
        private modalService: ModalService,
        private changeDetectorRef: ChangeDetectorRef,
        private dataService: DataService,
    ) {
        this.detailForm = this.formBuilder.group(
            {
                name: ['', [Validators.required, Validators.maxLength(255)]],
                description: [''],
                selectionType: ['CHECKBOX', Validators.required],
                isRequired: [false],
                minSelections: [0, [Validators.required, Validators.min(0)]],
                maxSelections: [1, [Validators.required, Validators.min(1)]],
                sortOrder: [0, [Validators.required, Validators.min(0)]],
                enabled: [true],
            },
            { validators: groupCrossValidator },
        );
        this.itemForm = this.formBuilder.group(
            {
                name: ['', [Validators.required, Validators.maxLength(255)]],
                price: [0, [Validators.required, Validators.min(0)]],
                sku: ['', Validators.maxLength(255)],
                minQuantity: [0, [Validators.required, Validators.min(0)]],
                maxQuantity: [1, [Validators.required, Validators.min(1)]],
            },
            { validators: itemCrossValidator },
        );
    }

    get isCheckbox(): boolean {
        return this.detailForm.get('selectionType')?.value === 'CHECKBOX';
    }

    private applyQuantityFieldsState(selectionType: string) {
        const minQty = this.itemForm.get('minQuantity');
        const maxQty = this.itemForm.get('maxQuantity');
        if (!minQty || !maxQty) return;
        if (selectionType === 'CHECKBOX') {
            minQty.setValue(0, { emitEvent: false });
            maxQty.setValue(1, { emitEvent: false });
            minQty.disable({ emitEvent: false });
            maxQty.disable({ emitEvent: false });
        } else {
            minQty.enable({ emitEvent: false });
            maxQty.enable({ emitEvent: false });
        }
    }

    ngOnInit() {
        this.applyQuantityFieldsState(this.detailForm.get('selectionType')?.value);
        this.detailForm
            .get('selectionType')
            ?.valueChanges.pipe(takeUntil(this.destroy$))
            .subscribe(value => this.applyQuantityFieldsState(value));
        this.dataService.settings.getActiveChannel().refetchOnChannelChange().mapStream(d => d.activeChannel).subscribe(channel => {
            const ch = channel as Record<string, unknown>;
            this.currencyCode = (ch['defaultCurrencyCode'] as string) || (ch['currencyCode'] as string) || 'USD';
            this.changeDetectorRef.markForCheck();
        });
        this.route.paramMap
            .pipe(
                switchMap(params => {
                    const id = params.get('id');
                    if (id && id !== 'create') {
                        this.isNew = false;
                        return this.apollo
                            .watchQuery<{ addonGroup: AddonGroupData }>({
                                query: GET_ADDON_GROUP,
                                variables: { id },
                                fetchPolicy: 'network-only',
                            })
                            .valueChanges.pipe(map(result => result.data.addonGroup));
                    }
                    this.isNew = true;
                    return of(null);
                }),
                takeUntil(this.destroy$),
            )
            .subscribe(group => {
                if (group) {
                    this.entity = group;
                    this.detailForm.patchValue({
                        name: group.name,
                        description: group.description || '',
                        selectionType: group.selectionType,
                        isRequired: group.isRequired,
                        minSelections: group.minSelections,
                        maxSelections: group.maxSelections,
                        sortOrder: group.sortOrder,
                        enabled: group.enabled,
                    });
                    this.detailForm.markAsPristine();
                    this.loadAssignedVariants(group.id);
                }
                this.changeDetectorRef.markForCheck();
            });
    }

    ngOnDestroy() {
        this.destroy$.next();
        this.destroy$.complete();
    }

    create() {
        if (this.detailForm.invalid) {
            this.detailForm.markAllAsTouched();
            return;
        }
        const formValue = this.detailForm.value;
        this.apollo
            .mutate<{ createAddonGroup: AddonGroupData }>({
                mutation: CREATE_ADDON_GROUP,
                variables: { input: formValue },
            })
            .subscribe({
                next: (result) => {
                    this.notificationService.success('Addon group created');
                    this.detailForm.markAsPristine();
                    const id = result.data?.createAddonGroup?.id;
                    if (id) {
                        this.router.navigate(['../', id], { relativeTo: this.route });
                    }
                },
                error: () => {
                    this.notificationService.error('Failed to create addon group');
                },
            });
    }

    save() {
        if (this.detailForm.invalid || !this.entity) {
            this.detailForm.markAllAsTouched();
            return;
        }
        const formValue = this.detailForm.value;
        this.apollo
            .mutate<{ updateAddonGroup: AddonGroupData }>({
                mutation: UPDATE_ADDON_GROUP,
                variables: {
                    input: { id: this.entity.id, ...formValue },
                },
            })
            .subscribe({
                next: (result) => {
                    this.notificationService.success('Addon group updated');
                    this.entity = result.data?.updateAddonGroup || this.entity;
                    this.detailForm.markAsPristine();
                    this.changeDetectorRef.markForCheck();
                },
                error: () => {
                    this.notificationService.error('Failed to update addon group');
                },
            });
    }

    pickNewItemImage() {
        this.modalService
            .fromComponent(AssetPickerDialogComponent, { size: 'xl' })
            .subscribe((assets: any) => {
                if (assets && assets.length > 0) {
                    const asset = assets[0];
                    this.newItemImageId = asset.id;
                    this.newItemImagePreview = asset.preview;
                    this.changeDetectorRef.markForCheck();
                }
            });
    }

    clearNewItemImage() {
        this.newItemImageId = null;
        this.newItemImagePreview = null;
        this.changeDetectorRef.markForCheck();
    }

    addItem() {
        if (this.itemForm.invalid || !this.entity) {
            this.itemForm.markAllAsTouched();
            return;
        }
        const formValue = this.itemForm.getRawValue();
        const input: any = {
            groupId: this.entity.id,
            name: formValue.name,
            price: Math.round((formValue.price || 0) * 100),
            sku: formValue.sku || null,
            minQuantity: formValue.minQuantity ?? 0,
            maxQuantity: formValue.maxQuantity ?? 1,
        };
        if (this.newItemImageId) {
            input.imageId = this.newItemImageId;
        }
        this.apollo
            .mutate({ mutation: CREATE_ADDON_ITEM, variables: { input } })
            .subscribe({
                next: () => {
                    this.notificationService.success('Addon item added');
                    this.itemForm.reset({ name: '', price: 0, sku: '', minQuantity: 0, maxQuantity: 1 });
                    this.clearNewItemImage();
                    this.showAddItem = false;
                    this.refreshGroup();
                },
                error: () => {
                    this.notificationService.error('Failed to add addon item');
                },
            });
    }

    startEditItem(item: AddonItemData) {
        this.editingItemId = item.id;
        this.editItemData = {
            ...item,
            price: item.price / 100,
            image: item.image ? { ...item.image } : null,
            imageId: undefined,
        };
    }

    cancelEditItem() {
        this.editingItemId = null;
        this.editItemData = {};
    }

    pickEditItemImage() {
        this.modalService
            .fromComponent(AssetPickerDialogComponent, { size: 'xl' })
            .subscribe((assets: any) => {
                if (assets && assets.length > 0) {
                    const asset = assets[0];
                    this.editItemData.image = { id: asset.id, preview: asset.preview };
                    this.editItemData.imageId = asset.id;
                    this.changeDetectorRef.markForCheck();
                }
            });
    }

    saveEditItem() {
        if (!this.editingItemId) return;
        if (this.isCheckbox) {
            this.editItemData.minQuantity = 0;
            this.editItemData.maxQuantity = 1;
        }
        const validationError = this.validateEditItem();
        if (validationError) {
            this.notificationService.error(validationError);
            return;
        }
        const input: any = {
            id: this.editingItemId,
            name: this.editItemData.name,
            price: Math.round((this.editItemData.price || 0) * 100),
            sku: this.editItemData.sku,
            isDefault: this.editItemData.isDefault,
            minQuantity: this.editItemData.minQuantity,
            maxQuantity: this.editItemData.maxQuantity,
            sortOrder: this.editItemData.sortOrder,
            enabled: this.editItemData.enabled,
        };
        // Only send imageId if it was explicitly changed
        if (this.editItemData.imageId !== undefined) {
            input.imageId = this.editItemData.imageId;
        } else if (this.editItemData.image === null) {
            input.imageId = null;
        }
        this.apollo
            .mutate({ mutation: UPDATE_ADDON_ITEM, variables: { input } })
            .subscribe({
                next: () => {
                    this.notificationService.success('Item updated');
                    this.editingItemId = null;
                    this.editItemData = {};
                    this.refreshGroup();
                },
                error: () => {
                    this.notificationService.error('Failed to update item');
                },
            });
    }

    private validateEditItem(): string | null {
        const d = this.editItemData;
        if (!d.name || !String(d.name).trim()) {
            return 'Name is required';
        }
        if (String(d.name).length > 255) {
            return 'Name is too long (max 255 characters)';
        }
        if (d.sku !== undefined && d.sku !== null && String(d.sku).length > 255) {
            return 'SKU is too long (max 255 characters)';
        }
        const price = Number(d.price);
        if (Number.isNaN(price) || price < 0) {
            return 'Price cannot be negative';
        }
        const minQty = Number(d.minQuantity);
        const maxQty = Number(d.maxQuantity);
        if (Number.isNaN(minQty) || minQty < 0) {
            return 'Min quantity cannot be negative';
        }
        if (Number.isNaN(maxQty) || maxQty < 1) {
            return 'Max quantity must be at least 1';
        }
        if (minQty > maxQty) {
            return 'Min quantity cannot be greater than max quantity';
        }
        const sortOrder = Number(d.sortOrder);
        if (Number.isNaN(sortOrder) || sortOrder < 0) {
            return 'Sort order cannot be negative';
        }
        return null;
    }

    deleteItem(item: AddonItemData) {
        this.modalService
            .dialog({
                title: 'Delete Addon Item',
                body: `Delete "${item.name}"?`,
                buttons: [
                    { type: 'secondary', label: 'Cancel' },
                    { type: 'danger', label: 'Delete', returnValue: true },
                ],
            })
            .pipe(
                switchMap(response => {
                    if (response) {
                        return this.apollo.mutate({
                            mutation: DELETE_ADDON_ITEM,
                            variables: { id: item.id },
                        });
                    }
                    return [];
                }),
            )
            .subscribe({
                next: () => {
                    this.notificationService.success('Item deleted');
                    this.refreshGroup();
                },
                error: () => {
                    this.notificationService.error('Failed to delete item');
                },
            });
    }

    private loadAssignedVariants(groupId: string) {
        this.apollo
            .query<{ variantsWithAddonGroup: AssignedVariant[] }>({
                query: GET_ASSIGNED_VARIANTS,
                variables: { addonGroupId: groupId },
                fetchPolicy: 'network-only',
            })
            .subscribe(result => {
                this.assignedVariants = result.data.variantsWithAddonGroup || [];
                this.changeDetectorRef.markForCheck();
            });
    }

    private refreshGroup() {
        if (!this.entity) return;
        this.apollo
            .query<{ addonGroup: AddonGroupData }>({
                query: GET_ADDON_GROUP,
                variables: { id: this.entity.id },
                fetchPolicy: 'network-only',
            })
            .subscribe(result => {
                this.entity = result.data.addonGroup;
                this.changeDetectorRef.markForCheck();
            });
    }
}

import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit, OnDestroy } from '@angular/core';
import { FormControl } from '@angular/forms';
import { SharedModule, FormInputComponent } from '@vendure/admin-ui/core';
import { Apollo } from 'apollo-angular';
import { Subscription } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import gql from 'graphql-tag';

const SEARCH_ADDON_GROUPS = gql`
    query SearchAddonGroups($options: AddonGroupListOptions) {
        addonGroups(options: $options) {
            items {
                id
                name
                selectionType
                isRequired
                enabled
                items { id name price }
            }
            totalItems
        }
    }
`;

const GET_ADDON_GROUP = gql`
    query GetAddonGroup($id: ID!) {
        addonGroup(id: $id) {
            id
            name
            selectionType
            isRequired
            enabled
            items { id name price }
        }
    }
`;

interface AddonGroupResult {
    id: string;
    name: string;
    selectionType: string;
    isRequired: boolean;
    enabled: boolean;
    items: { id: string; name: string; price: number }[];
}

@Component({
    selector: 'addon-group-input',
    template: `
        <div class="wrapper">
            <!-- Search -->
            <div class="search-wrapper">
                <input
                    type="text"
                    class="search-input"
                    placeholder="Type to search addon groups..."
                    [(ngModel)]="searchTerm"
                    (input)="onSearch()"
                    (focus)="onFocus()"
                    [disabled]="readonly"
                />
                <div class="results" *ngIf="showDropdown">
                    <div *ngIf="searchResults.length === 0 && searchTerm.length > 0" class="no-results">
                        No groups found
                    </div>
                    <div
                        *ngFor="let g of searchResults"
                        class="result-item"
                        [class.disabled]="isAssigned(g.id)"
                        (click)="assign(g)"
                    >
                        <div class="result-left">
                            <strong>{{ g.name }}</strong>
                            <span class="tag blue">{{ g.selectionType === 'CHECKBOX' ? 'Checkbox' : 'Quantity' }}</span>
                            <span class="tag orange" *ngIf="g.isRequired">Required</span>
                        </div>
                        <div class="result-right">
                            <span class="meta">{{ g.items.length }} item{{ g.items.length !== 1 ? 's' : '' }}</span>
                            <span class="meta assigned-text" *ngIf="isAssigned(g.id)">Already assigned</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Assigned groups -->
            <div *ngIf="assignedGroups.length > 0" class="assigned">
                <table class="table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Type</th>
                            <th>Required</th>
                            <th>Items</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr *ngFor="let g of assignedGroups">
                            <td><strong>{{ g.name }}</strong></td>
                            <td><span class="tag blue">{{ g.selectionType === 'CHECKBOX' ? 'Checkbox' : 'Quantity' }}</span></td>
                            <td><span class="tag" [class.orange]="g.isRequired" [class.grey]="!g.isRequired">{{ g.isRequired ? 'Yes' : 'No' }}</span></td>
                            <td>{{ g.items.length }}</td>
                            <td>
                                <button class="btn-remove" (click)="remove(g)" *ngIf="!readonly" title="Remove">
                                    <clr-icon shape="trash" size="14"></clr-icon>
                                </button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <div *ngIf="assignedGroups.length === 0" class="empty-state">
                No addon groups assigned. Use the search above to find and assign groups.
            </div>
        </div>
    `,
    styles: [`
        .wrapper { font-size: 13px; }
        .search-wrapper { position: relative; margin-bottom: 12px; }
        .search-input {
            width: 100%; padding: 8px 12px; border: 1px solid var(--color-component-border-200, #ccc);
            border-radius: 3px; font-size: 13px; background: var(--color-component-bg-100, #fff);
            color: var(--color-text-100, #333);
        }
        .search-input:focus { outline: none; border-color: var(--color-primary-500, #0066cc); }
        .search-input:disabled { opacity: 0.6; cursor: not-allowed; }
        .results {
            position: absolute; top: 100%; left: 0; right: 0; z-index: 1000;
            background: var(--color-component-bg-100, #fff);
            border: 1px solid var(--color-component-border-200, #ddd);
            border-radius: 3px; margin-top: 2px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            max-height: 220px; overflow-y: auto;
        }
        .result-item {
            padding: 8px 12px; cursor: pointer;
            display: flex; justify-content: space-between; align-items: center;
            border-bottom: 1px solid var(--color-component-border-100, #eee);
        }
        .result-item:last-child { border-bottom: none; }
        .result-item:hover { background: var(--color-component-bg-200, #f5f5f5); }
        .result-item.disabled { opacity: 0.4; cursor: not-allowed; }
        .result-left { display: flex; align-items: center; gap: 6px; }
        .result-right { display: flex; align-items: center; gap: 8px; }
        .no-results { padding: 12px; text-align: center; color: var(--color-text-300, #999); }
        .meta { font-size: 11px; color: var(--color-text-300, #999); }
        .assigned-text { font-style: italic; }
        .tag {
            display: inline-block; padding: 1px 6px; border-radius: 3px;
            font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
        }
        .tag.blue { background: #dbeafe; color: #1e40af; }
        .tag.orange { background: #ffedd5; color: #9a3412; }
        .tag.grey { background: #f3f4f6; color: #6b7280; }
        .assigned { margin-top: 4px; }
        .table {
            width: 100%; border-collapse: collapse;
            border: 1px solid var(--color-component-border-100, #e5e7eb);
            border-radius: 3px; overflow: hidden;
        }
        .table th {
            text-align: left; padding: 6px 10px; font-size: 11px;
            font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
            color: var(--color-text-300, #6b7280);
            background: var(--color-component-bg-200, #f9fafb);
            border-bottom: 1px solid var(--color-component-border-100, #e5e7eb);
        }
        .table td {
            padding: 8px 10px;
            border-bottom: 1px solid var(--color-component-border-100, #f3f4f6);
        }
        .table tr:last-child td { border-bottom: none; }
        .btn-remove {
            border: none; background: none; cursor: pointer; padding: 4px;
            color: var(--color-text-300, #999); border-radius: 3px; line-height: 1;
        }
        .btn-remove:hover { color: #dc2626; background: #fef2f2; }
        .empty-state {
            text-align: center; padding: 20px; color: var(--color-text-300, #999);
            border: 1px dashed var(--color-component-border-200, #ddd); border-radius: 3px;
        }
    `],
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: true,
    imports: [SharedModule],
})
export class AddonGroupInputComponent implements FormInputComponent, OnInit, OnDestroy {
    static readonly id = 'addon-group-relation-input';
    readonly!: boolean;
    formControl!: FormControl;
    config: any;
    isListInput = true;

    searchResults: AddonGroupResult[] = [];
    assignedGroups: AddonGroupResult[] = [];
    showDropdown = false;
    searchTerm = '';
    private searchTimeout: any;
    private valueSub: Subscription | null = null;

    constructor(
        private apollo: Apollo,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit(): void {
        document.addEventListener('click', this.onDocClick);
        const raw = this.formControl.value;
        if (Array.isArray(raw) && raw.length > 0) {
            this.loadInitialGroups();
        } else {
            // Data not yet available — wait for Vendure to patch the form after fetch
            this.valueSub = this.formControl.valueChanges
                .pipe(
                    filter(val => Array.isArray(val) && val.length > 0),
                    take(1),
                )
                .subscribe(() => {
                    this.loadInitialGroups();
                });
        }
    }

    ngOnDestroy(): void {
        document.removeEventListener('click', this.onDocClick);
        clearTimeout(this.searchTimeout);
        this.valueSub?.unsubscribe();
    }

    onSearch(): void {
        clearTimeout(this.searchTimeout);
        if (this.searchTerm.length < 1) {
            this.searchResults = [];
            this.showDropdown = false;
            this.cdr.markForCheck();
            return;
        }
        this.searchTimeout = setTimeout(() => {
            this.apollo.query<{ addonGroups: { items: AddonGroupResult[] } }>({
                query: SEARCH_ADDON_GROUPS,
                variables: { options: { take: 10, filter: { name: { contains: this.searchTerm } } } },
                fetchPolicy: 'network-only',
            }).subscribe(({ data }) => {
                this.searchResults = data.addonGroups.items;
                this.showDropdown = true;
                this.cdr.markForCheck();
            });
        }, 250);
    }

    onFocus(): void {
        if (this.searchResults.length > 0) {
            this.showDropdown = true;
            this.cdr.markForCheck();
        }
    }

    isAssigned(id: string): boolean {
        return this.assignedGroups.some(g => g.id === id);
    }

    assign(group: AddonGroupResult): void {
        if (this.readonly || this.isAssigned(group.id)) return;
        this.assignedGroups = [...this.assignedGroups, group];
        this.syncFormValue();
        this.showDropdown = false;
        this.searchTerm = '';
        this.searchResults = [];
        this.cdr.markForCheck();
    }

    remove(group: AddonGroupResult): void {
        if (this.readonly) return;
        this.assignedGroups = this.assignedGroups.filter(g => g.id !== group.id);
        this.syncFormValue();
        this.cdr.markForCheck();
    }

    /**
     * Sets the formControl value to match assignedGroups and marks as dirty.
     * Only call this for user-initiated changes (assign/remove).
     */
    private syncFormValue(): void {
        const value = this.assignedGroups.map(g => ({ id: String(g.id) }));
        this.formControl.setValue(value);
        this.formControl.markAsDirty();
    }

    /**
     * Silently sets the formControl value without marking dirty.
     * Used during initialization to normalize the value.
     */
    private setFormValueSilent(): void {
        const value = this.assignedGroups.map(g => ({ id: String(g.id) }));
        this.formControl.setValue(value, { emitEvent: false });
    }

    /**
     * Read initial form value and load full group data for display.
     * Normalizes form value without marking the form as dirty.
     */
    private loadInitialGroups(): void {
        const raw = this.formControl.value;
        if (!Array.isArray(raw) || raw.length === 0) return;

        const ids: string[] = [];
        for (const v of raw) {
            if (v == null) continue;
            if (typeof v === 'string' && v !== '') {
                ids.push(v);
            } else if (typeof v === 'number') {
                ids.push(String(v));
            } else if (typeof v === 'object' && v.id != null) {
                ids.push(String(v.id));
                // Only treat as fully loaded when ALL display fields are present,
                // otherwise the table renders with empty Type/Items columns.
                if (this.hasFullData(v) && !this.assignedGroups.some(g => g.id === String(v.id))) {
                    this.assignedGroups.push(v as AddonGroupResult);
                }
            }
        }

        this.setFormValueSilent();
        this.cdr.markForCheck();

        // Always fetch full data when we don't have it yet — covers the first-render
        // case where the parent variant query returned only `{id, name}` objects.
        const loadedIds = new Set(
            this.assignedGroups.filter(g => this.hasFullData(g)).map(g => String(g.id)),
        );
        for (const id of ids) {
            if (loadedIds.has(id)) continue;
            this.apollo.query<{ addonGroup: AddonGroupResult | null }>({
                query: GET_ADDON_GROUP,
                variables: { id },
                fetchPolicy: 'network-only',
            }).subscribe(({ data }) => {
                if (!data.addonGroup) return;
                const fetched = data.addonGroup;
                const idx = this.assignedGroups.findIndex(g => String(g.id) === String(fetched.id));
                if (idx >= 0) {
                    // Replace the partial entry with the full one
                    const next = [...this.assignedGroups];
                    next[idx] = fetched;
                    this.assignedGroups = next;
                } else {
                    this.assignedGroups = [...this.assignedGroups, fetched];
                }
                this.setFormValueSilent();
                this.cdr.markForCheck();
            });
        }
    }

    private hasFullData(g: any): boolean {
        return !!g && g.name != null && g.selectionType != null && Array.isArray(g.items);
    }

    private onDocClick = (e: MouseEvent): void => {
        if (!(e.target as HTMLElement).closest('.search-wrapper')) {
            this.showDropdown = false;
            this.cdr.markForCheck();
        }
    };
}

import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
    DataService,
    SharedModule,
    TypedBaseListComponent,
} from '@vendure/admin-ui/core';
import gql from 'graphql-tag';

export const GET_ADDON_GROUPS = gql`
    query GetAddonGroupsList($options: AddonGroupListOptions) {
        addonGroups(options: $options) {
            items {
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
                    name
                    price
                    enabled
                }
            }
            totalItems
        }
    }
`;

export const DELETE_ADDON_GROUP = gql`
    mutation DeleteAddonGroup($id: ID!) {
        deleteAddonGroup(id: $id) {
            result
            message
        }
    }
`;

export const ASSIGN_ADDON_GROUPS_TO_CHANNEL = gql`
    mutation AssignAddonGroupsToChannel($input: AssignAddonGroupsToChannelInput!) {
        assignAddonGroupsToChannel(input: $input) {
            id
        }
    }
`;

export const REMOVE_ADDON_GROUPS_FROM_CHANNEL = gql`
    mutation RemoveAddonGroupsFromChannel($input: RemoveAddonGroupsFromChannelInput!) {
        removeAddonGroupsFromChannel(input: $input) {
            id
        }
    }
`;

@Component({
    selector: 'addon-group-list',
    template: `
        <vdr-page-block>
            <vdr-action-bar>
                <vdr-ab-left></vdr-ab-left>
                <vdr-ab-right>
                    <a class="btn btn-primary" [routerLink]="['./create']">
                        <clr-icon shape="plus"></clr-icon>
                        Add Addon Group
                    </a>
                </vdr-ab-right>
            </vdr-action-bar>
        </vdr-page-block>
        <vdr-data-table-2
            id="addon-group-list"
            [items]="items$ | async"
            [itemsPerPage]="itemsPerPage$ | async"
            [totalItems]="totalItems$ | async"
            [currentPage]="currentPage$ | async"
            [filters]="filters"
            (pageChange)="setPageNumber($event)"
            (itemsPerPageChange)="setItemsPerPage($event)"
        >
            <vdr-bulk-action-menu
                locationId="addon-group-list"
                [hostComponent]="this"
                [selectionManager]="selectionManager"
            />
            <vdr-dt2-search
                [searchTermControl]="searchTermControl"
                searchTermPlaceholder="Filter by name"
            />
            <vdr-dt2-column heading="ID" [hiddenByDefault]="true" [sort]="sorts.get('id')">
                <ng-template let-group="item">{{ group.id }}</ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Created" [hiddenByDefault]="true" [sort]="sorts.get('createdAt')">
                <ng-template let-group="item">{{ group.createdAt | localeDate:'short' }}</ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Updated" [hiddenByDefault]="true" [sort]="sorts.get('updatedAt')">
                <ng-template let-group="item">{{ group.updatedAt | localeDate:'short' }}</ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Name" [optional]="false" [sort]="sorts.get('name')">
                <ng-template let-group="item">
                    <a class="button-ghost" [routerLink]="['./', group.id]">
                        <span>{{ group.name }}</span>
                        <clr-icon shape="arrow right"></clr-icon>
                    </a>
                    <div *ngIf="group.description" class="muted small">{{ group.description }}</div>
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Type">
                <ng-template let-group="item">
                    <vdr-chip [colorType]="group.selectionType === 'CHECKBOX' ? 'success' : 'warning'">
                        {{ group.selectionType === 'CHECKBOX' ? 'Checkbox' : 'Quantity' }}
                    </vdr-chip>
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Required">
                <ng-template let-group="item">
                    <vdr-chip [colorType]="group.isRequired ? 'error' : 'success'">
                        {{ group.isRequired ? 'Required' : 'Optional' }}
                    </vdr-chip>
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Items">
                <ng-template let-group="item">
                    <span class="count-pill">{{ group.items.length }}</span>
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Status" [sort]="sorts.get('enabled')">
                <ng-template let-group="item">
                    <vdr-chip [colorType]="group.enabled ? 'success' : 'error'">
                        {{ group.enabled ? 'Active' : 'Disabled' }}
                    </vdr-chip>
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Sort order" [hiddenByDefault]="true" [sort]="sorts.get('sortOrder')">
                <ng-template let-group="item">{{ group.sortOrder }}</ng-template>
            </vdr-dt2-column>
        </vdr-data-table-2>
    `,
    styles: [`
        .button-ghost { display: inline-flex; align-items: center; gap: 4px; }
        .muted.small { font-size: 12px; color: var(--color-text-300); margin-top: 2px; }
        .count-pill {
            display: inline-flex; align-items: center; justify-content: center;
            min-width: 24px; height: 24px; padding: 0 8px; border-radius: 12px;
            background: var(--color-component-bg-300); font-size: 12px; font-weight: 600;
        }
    `],
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: true,
    imports: [SharedModule],
})
export class AddonGroupListComponent extends TypedBaseListComponent<typeof GET_ADDON_GROUPS, 'addonGroups'> {
    readonly dataTableListId = 'addon-group-list';
    readonly filters = this.createFilterCollection()
        .addFilter({
            name: 'enabled',
            type: { kind: 'boolean' },
            label: 'Enabled',
            filterField: 'enabled',
        })
        .addFilter({
            name: 'isRequired',
            type: { kind: 'boolean' },
            label: 'Required',
            filterField: 'isRequired',
        })
        .addFilter({
            name: 'selectionType',
            type: {
                kind: 'select',
                options: [
                    { value: 'CHECKBOX', label: 'Checkbox' },
                    { value: 'QUANTITY', label: 'Quantity' },
                ],
            },
            label: 'Selection type',
            filterField: 'selectionType',
        })
        .connectToRoute(this.route);

    readonly sorts = this.createSortCollection()
        .defaultSort('createdAt', 'DESC')
        .addSort({ name: 'id' })
        .addSort({ name: 'name' })
        .addSort({ name: 'createdAt' })
        .addSort({ name: 'updatedAt' })
        .addSort({ name: 'enabled' })
        .addSort({ name: 'sortOrder' })
        .connectToRoute(this.route);

    constructor() {
        super();
        super.configure({
            document: GET_ADDON_GROUPS as any,
            getItems: (data: any) => data.addonGroups,
            setVariables: ((skip: number, take: number) => {
                const term = (this.searchTermControl.value ?? '').trim();
                const termFilter: Record<string, unknown> = term
                    ? /^\d+$/.test(term)
                        ? { id: { eq: term } }
                        : { name: { contains: term } }
                    : {};
                return {
                    options: {
                        skip,
                        take,
                        filter: {
                            ...termFilter,
                            ...(this.filters.createFilterInput() as Record<string, unknown>),
                        },
                        sort: this.sorts.createSortInput(),
                    },
                };
            }) as any,
            refreshListOnChanges: [
                this.filters.valueChanges,
                this.sorts.valueChanges,
                this.searchTermControl.valueChanges,
            ],
        });
    }
}

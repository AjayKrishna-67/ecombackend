import {
    addNavMenuItem,
    createBulkAssignToChannelAction,
    createBulkDeleteAction,
    createBulkRemoveFromChannelAction,
    DataService,
    registerBulkAction,
    registerCustomDetailComponent,
    registerFormInputComponent,
} from '@vendure/admin-ui/core';
import { forkJoin, of } from 'rxjs';
import { map } from 'rxjs/operators';
import { AddonGroupInputComponent } from './addon-group-input.component';
import { AddonOrderDetailComponent } from './addon-order-detail.component';
import {
    ASSIGN_ADDON_GROUPS_TO_CHANNEL,
    DELETE_ADDON_GROUP,
    REMOVE_ADDON_GROUPS_FROM_CHANNEL,
} from './addon-group-list.component';

interface AddonGroupListItem {
    id: string;
    name: string;
}

export default [
    addNavMenuItem(
        {
            id: 'addon-group-ui',
            label: 'Addon Groups',
            routerLink: ['/extensions/addon-group'],
            icon: 'bundle',
            requiresPermission: 'ReadAddonGroup',
        },
        'catalog',
    ),
    registerFormInputComponent('addon-group-relation-input', AddonGroupInputComponent),
    registerCustomDetailComponent({
        locationId: 'order-detail',
        component: AddonOrderDetailComponent,
    }),
    registerBulkAction(
        createBulkDeleteAction<AddonGroupListItem>({
            location: 'addon-group-list',
            requiresPermission: 'DeleteAddonGroup',
            getItemName: item => item.name,
            bulkDelete: (dataService, ids) =>
                ids.length === 0
                    ? of([])
                    : forkJoin(
                          ids.map(id =>
                              dataService
                                  .mutate(DELETE_ADDON_GROUP, { id })
                                  .pipe(map((res: any) => res?.deleteAddonGroup)),
                          ),
                      ),
        }),
    ),
    registerBulkAction(
        createBulkAssignToChannelAction<AddonGroupListItem>({
            location: 'addon-group-list',
            requiresPermission: 'UpdateAddonGroup',
            getItemName: item => item.name,
            bulkAssignToChannel: (dataService: DataService, ids, channelIds) =>
                channelIds.map(channelId =>
                    dataService
                        .mutate(ASSIGN_ADDON_GROUPS_TO_CHANNEL, {
                            input: { addonGroupIds: ids, channelId },
                        })
                        .pipe(map((res: any) => res?.assignAddonGroupsToChannel ?? [])),
                ),
        }),
    ),
    registerBulkAction(
        createBulkRemoveFromChannelAction<AddonGroupListItem>({
            location: 'addon-group-list',
            requiresPermission: 'UpdateAddonGroup',
            getItemName: item => item.name,
            bulkRemoveFromChannel: (dataService: DataService, ids, channelId) =>
                dataService
                    .mutate(REMOVE_ADDON_GROUPS_FROM_CHANNEL, {
                        input: { addonGroupIds: ids, channelId },
                    })
                    .pipe(map((res: any) => res?.removeAddonGroupsFromChannel ?? [])),
        }),
    ),
];

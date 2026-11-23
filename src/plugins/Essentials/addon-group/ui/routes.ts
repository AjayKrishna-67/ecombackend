import { registerRouteComponent } from '@vendure/admin-ui/core';
import { AddonGroupListComponent } from './addon-group-list.component';
import { AddonGroupDetailComponent } from './addon-group-detail.component';

export default [
    registerRouteComponent({
        component: AddonGroupListComponent,
        path: '',
        title: 'Addon Groups',
        breadcrumb: [
            { label: 'Addon Groups', link: ['/extensions', 'addon-group'] },
        ],
    }),
    registerRouteComponent({
        component: AddonGroupDetailComponent,
        path: ':id',
        title: 'Addon Group Details',
        breadcrumb: [
            { label: 'Addon Groups', link: ['/extensions', 'addon-group'] },
            { label: 'Details', link: [] },
        ],
    }),
];

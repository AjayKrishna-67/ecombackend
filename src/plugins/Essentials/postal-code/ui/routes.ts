import { registerRouteComponent } from '@vendure/admin-ui/core';
import { PostalCodeListComponent } from './postal-code-list.component';
import { PostalCodeDetailComponent } from './postal-code-detail.component';

export default [
    registerRouteComponent({
        component: PostalCodeListComponent,
        path: '',
        title: 'Postal Codes',
        breadcrumb: [
            { label: 'Postal Codes', link: ['/extensions', 'postal-code'] },
        ],
    }),
    registerRouteComponent({
        component: PostalCodeDetailComponent,
        path: ':id',
        title: 'Postal Code Details',
        breadcrumb: [
            { label: 'Postal Codes', link: ['/extensions', 'postal-code'] },
            { label: 'Details', link: [] },
        ],
    }),
];

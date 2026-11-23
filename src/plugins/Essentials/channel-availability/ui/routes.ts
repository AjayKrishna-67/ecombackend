import { registerRouteComponent } from '@vendure/admin-ui/core';
import { BrandStorefrontComponent } from './brand-storefront.component';

export default [
    registerRouteComponent({
        component: BrandStorefrontComponent,
        path: '',
        title: 'Brand Storefronts',
        breadcrumb: 'Brand Storefronts',
    }),
];

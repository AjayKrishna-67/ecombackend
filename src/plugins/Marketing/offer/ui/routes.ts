import { registerRouteComponent } from '@vendure/admin-ui/core';
import { OfferComponent } from './offer.component';

export default [
    registerRouteComponent({
        component: OfferComponent,
        path: '',
        title: 'Offer Management',
        breadcrumb: 'Offers',
    }),
];

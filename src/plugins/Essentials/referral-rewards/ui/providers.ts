import {
    registerCustomDetailComponent,
} from '@vendure/admin-ui/core';
import { ReferralListComponent } from './components/referral-list/referral-list.component';
import { ReferredByCardComponent } from './components/referred-by-card/referred-by-card.component';

export default [
    registerCustomDetailComponent({
        locationId: 'customer-detail',
        component: ReferredByCardComponent,
    }),
    registerCustomDetailComponent({
        locationId: 'customer-detail',
        component: ReferralListComponent,
    }),
];

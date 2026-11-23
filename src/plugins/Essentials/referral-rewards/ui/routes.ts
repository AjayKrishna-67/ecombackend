import { registerRouteComponent } from '@vendure/admin-ui/core';
import { ReferralHistoryComponent } from './ReferralHistoryComponent';

export default [
    registerRouteComponent({
        component: ReferralHistoryComponent,
        path: '',
        title: 'Referral History',
        breadcrumb: 'Referral History',
    }),
];

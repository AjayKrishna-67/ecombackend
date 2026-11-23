import { registerRouteComponent } from '@vendure/admin-ui/core';
import { ShiprocketSettingsComponent } from './shiprocket-settings.component';

export default [
    registerRouteComponent({
        component: ShiprocketSettingsComponent,
        path: '',
        title: 'Shiprocket International',
        breadcrumb: 'Shiprocket International',
    }),
];

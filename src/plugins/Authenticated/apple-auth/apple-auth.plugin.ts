import { PluginCommonModule, VendurePlugin } from '@vendure/core';

@VendurePlugin({
    imports: [PluginCommonModule],
    compatibility: '^3.6.3',
})
export class AppleAuthPlugin {}

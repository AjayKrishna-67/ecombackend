import { PluginCommonModule, VendurePlugin } from '@vendure/core';

/**
 * Dashboard-only plugin. Carries presentation tweaks to the built-in React
 * Dashboard pages (column renderers, list tables) that do not belong to any
 * single domain plugin. No entities, services or API extensions.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    dashboard: './dashboard/index.tsx',
    compatibility: '^3.6.3',
})
export class DashboardUiPlugin {}

import { PermissionDefinition } from '@vendure/core';

export const bulkSyncPermission = new PermissionDefinition({
    name: 'BulkSyncProducts',
    description: 'Allows bulk price/stock sync via the /bulk-sync REST endpoints',
});

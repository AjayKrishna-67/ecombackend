import { PermissionDefinition } from '@vendure/core';

export const readAbandonedCartPermission = new PermissionDefinition({
    name: 'ReadAbandonedCart',
    description: 'Allows reading abandoned-cart re-engagement settings',
});

export const updateAbandonedCartPermission = new PermissionDefinition({
    name: 'UpdateAbandonedCart',
    description: 'Allows editing abandoned-cart re-engagement settings',
});

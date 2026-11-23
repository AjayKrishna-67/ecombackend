import { PermissionDefinition } from '@vendure/core';

export const customFulfillmentPermission = new PermissionDefinition({
    name: 'CustomFulfillment',
    description: 'Allows creating fulfillments with delivery person assignment',
});

export const outForDeliveryPermission = new PermissionDefinition({
    name: 'TransitionToOutForDelivery',
    description: 'Allows transitioning fulfillments to OutforDelivery state',
});

export const deliveredPermission = new PermissionDefinition({
    name: 'TransitionToDelivered',
    description: 'Allows transitioning fulfillments to Delivered state',
});

export const viewDeliveryReportsPermission = new PermissionDefinition({
    name: 'ViewDeliveryReports',
    description: 'Allows viewing delivery reports across all delivery persons',
});

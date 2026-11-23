import { PermissionDefinition } from '@vendure/core';

/**
 * Permission for Loyalty Points operations
 * Allows users to view and manage loyalty points configurations
 */
export const loyaltyPointsPermission = new PermissionDefinition({
    name: 'LoyaltyPoints',
    description: 'Allows viewing and managing loyalty points configurations',
});


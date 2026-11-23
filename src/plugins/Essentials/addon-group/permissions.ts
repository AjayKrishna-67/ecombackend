import { CrudPermissionDefinition } from '@vendure/core';

/**
 * AddonGroup permissions for role-based access control
 * Creates 4 permissions: CreateAddonGroup, ReadAddonGroup, UpdateAddonGroup, DeleteAddonGroup
 */
export const addonGroupPermission = new CrudPermissionDefinition('AddonGroup');

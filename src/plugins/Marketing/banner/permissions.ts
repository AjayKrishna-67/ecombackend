import { CrudPermissionDefinition } from '@vendure/core';

/**
 * Banner permissions for role-based access control
 * Creates 4 permissions: CreateBanner, ReadBanner, UpdateBanner, DeleteBanner
 */
export const bannerPermission = new CrudPermissionDefinition('Banner');

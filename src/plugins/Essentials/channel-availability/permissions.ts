import { CrudPermissionDefinition } from '@vendure/core';

/**
 * Brand Storefront permissions for role-based access control.
 * Creates 4 permissions: CreateBrandStorefront, ReadBrandStorefront,
 * UpdateBrandStorefront, DeleteBrandStorefront.
 */
export const brandStorefrontPermission = new CrudPermissionDefinition('BrandStorefront');

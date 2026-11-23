import { CrudPermissionDefinition } from '@vendure/core';

/**
 * Postal Code permissions for role-based access control
 * Creates 4 permissions: CreatePostalCode, ReadPostalCode, UpdatePostalCode, DeletePostalCode
 */
export const postalCodePermission = new CrudPermissionDefinition('PostalCode');



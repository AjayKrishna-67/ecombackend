import { CrudPermissionDefinition } from '@vendure/core';

/**
 * Offer permissions for role-based access control
 * Creates 4 permissions: CreateOffer, ReadOffer, UpdateOffer, DeleteOffer
 */
export const offerPermission = new CrudPermissionDefinition('Offer');

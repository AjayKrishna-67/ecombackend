import { PermissionDefinition } from '@vendure/core';

/**
 * Read access to the admin activity log.
 *
 * Read-only by design: audit rows are append-only and are never created, edited
 * or deleted through the API. Retention is handled by the prune task instead.
 *
 * Every resolver guarded by this permission MUST also list
 * `Permission.SuperAdmin` on the same `@Allow`, or the feature fails closed on
 * first deploy because no existing role carries the new permission yet.
 */
export const adminActivityLogPermission = new PermissionDefinition({
    name: 'ReadAdminActivityLog',
    description: 'Allows reading the admin activity log and administrator session history',
});

import { PermissionDefinition } from '@vendure/core';

/**
 * Read permission gating the Customer Analytics queries (summary / list / save-as-group
 * read side). Granted to roles explicitly; resolvers also allow SuperAdmin as a fallback
 * so the feature does not fail closed on first deploy before the permission is assigned
 * to any role.
 */
export const customerAnalyticsPermission = new PermissionDefinition({
    name: 'ReadCustomerAnalytics',
    description: 'Allows reading customer analytics (RFM / recency segments)',
});

/**
 * Write permission gating threshold edits (the {@link setRecencyThresholds} mutation).
 * Kept separate from the read permission so a role can be granted view-only access to
 * the analytics page while threshold tuning stays with admins.
 */
export const updateCustomerAnalyticsPermission = new PermissionDefinition({
    name: 'UpdateCustomerAnalytics',
    description: 'Allows editing customer analytics recency thresholds',
});

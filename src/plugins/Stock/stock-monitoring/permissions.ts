import { PermissionDefinition } from '@vendure/core';

/**
 * Permission for Stock Monitoring operations
 * Allows users to view the stock monitoring widget on the dashboard
 */
export const stockMonitoringPermission = new PermissionDefinition({
  name: 'ReadStockMonitoring',
  description: 'Allows viewing the stock monitoring dashboard widget',
});


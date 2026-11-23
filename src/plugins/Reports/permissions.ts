import { PermissionDefinition } from '@vendure/core';

export const viewBusinessReportsPermission = new PermissionDefinition({
    name: 'ViewBusinessReports',
    description: 'Umbrella: viewing all business reports (sales, orders, channel performance)',
});

// ─── Granular report permissions ──────────────────────────────────────
// Each grants access to one report area. ViewBusinessReports (above) still
// grants all of them, so existing roles keep working.

export const viewDailyInvoiceReportPermission = new PermissionDefinition({
    name: 'ViewDailyInvoiceReport',
    description: 'Allows viewing the Daily Sales / invoice (bill-print) reports',
});

export const viewMonthlySalesReportPermission = new PermissionDefinition({
    name: 'ViewMonthlySalesReport',
    description: 'Allows viewing the Sales Report and Monthly Product Sales reports',
});

export const manageProductTamilNamesPermission = new PermissionDefinition({
    name: 'ManageProductTamilNames',
    description: 'Allows uploading/updating product Tamil names',
});

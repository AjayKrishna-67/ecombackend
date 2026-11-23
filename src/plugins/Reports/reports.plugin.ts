import { PluginCommonModule, VendurePlugin } from '@vendure/core';

import { adminApiExtensions } from './api/api-extensions';
import { ReportsAdminResolver } from './api/reports.resolver';
import {
    manageProductTamilNamesPermission,
    viewBusinessReportsPermission,
    viewDailyInvoiceReportPermission,
    viewMonthlySalesReportPermission,
} from './permissions';
import { PurchaseListService } from './purchase-list/services/purchase-list.service';
import { PurchaseListPdfService } from './purchase-list/services/purchase-list-pdf.service';
import { OrdersReportService } from './service/orders-report.service';
import { ReportsCacheInvalidationService } from './service/reports-cache-invalidation.service';

@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [
        OrdersReportService,
        PurchaseListService,
        PurchaseListPdfService,
        // Clears the cached reports when a product or variant is edited, so a
        // renamed variant prints under its new name on the next load.
        ReportsCacheInvalidationService,
    ],
    // Exported so the scheduled-report sender can build the PDF in-process.
    // GraphQL is a transport for outside callers; the worker lives in the same
    // application and just calls the method.
    exports: [PurchaseListService, PurchaseListPdfService],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [ReportsAdminResolver],
    },
    compatibility: '^3.1.0',
    configuration: config => {
        config.authOptions.customPermissions.push(
            viewBusinessReportsPermission,
            viewDailyInvoiceReportPermission,
            viewMonthlySalesReportPermission,
            manageProductTamilNamesPermission,
        );
        return config;
    },
})
export class ReportsPlugin {}

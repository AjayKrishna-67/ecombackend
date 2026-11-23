import { Args, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, RequestContext } from '@vendure/core';

import {
    viewBusinessReportsPermission,
    viewDailyInvoiceReportPermission,
    viewMonthlySalesReportPermission,
} from '../permissions';
import {
    BillPrintReport,
    BillPrintReportInput,
    DeliveredOrdersReport,
    DeliveredOrdersReportInput,
    MonthlyProductSalesReport,
    MonthlyProductSalesReportInput,
    OrdersReportService,
    SalesReport,
    SalesReportInput,
} from '../service/orders-report.service';
import {
    PurchaseListReport,
    PurchaseListReportInput,
    PurchaseListService,
} from '../purchase-list/services/purchase-list.service';

@Resolver()
export class ReportsAdminResolver {
    constructor(
        private readonly ordersReportService: OrdersReportService,
        private readonly purchaseListService: PurchaseListService,
    ) {}

    @Query()
    @Allow(viewBusinessReportsPermission.Permission)
    async deliveredOrdersReport(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: DeliveredOrdersReportInput },
    ): Promise<DeliveredOrdersReport> {
        return this.ordersReportService.getDeliveredOrdersReport(ctx, args.input);
    }

    @Query()
    @Allow(viewBusinessReportsPermission.Permission, viewMonthlySalesReportPermission.Permission)
    async salesReport(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: SalesReportInput },
    ): Promise<SalesReport> {
        return this.ordersReportService.getSalesReport(ctx, args.input);
    }

    @Query()
    @Allow(viewBusinessReportsPermission.Permission, viewMonthlySalesReportPermission.Permission)
    async monthlyProductSalesReport(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: MonthlyProductSalesReportInput },
    ): Promise<MonthlyProductSalesReport> {
        return this.ordersReportService.getMonthlyProductSalesReport(ctx, args.input);
    }

    /**
     * The Purchase List: what to buy, aggregated from outstanding orders.
     *
     * Same permission as the bill print report -- it is derived from exactly the
     * same order data, just summarised differently.
     */
    @Query()
    @Allow(viewBusinessReportsPermission.Permission, viewDailyInvoiceReportPermission.Permission)
    async purchaseListReport(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: PurchaseListReportInput },
    ): Promise<PurchaseListReport> {
        return this.purchaseListService.getPurchaseListReport(ctx, args.input);
    }

    @Query()
    @Allow(viewBusinessReportsPermission.Permission, viewDailyInvoiceReportPermission.Permission)
    async billPrintReport(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: BillPrintReportInput },
    ): Promise<BillPrintReport> {
        return this.ordersReportService.getBillPrintReport(ctx, args.input);
    }

    @Query()
    @Allow(
        viewBusinessReportsPermission.Permission,
        viewDailyInvoiceReportPermission.Permission,
        viewMonthlySalesReportPermission.Permission,
    )
    availableOrderStates(): string[] {
        return this.ordersReportService.getAvailableOrderStates();
    }
}

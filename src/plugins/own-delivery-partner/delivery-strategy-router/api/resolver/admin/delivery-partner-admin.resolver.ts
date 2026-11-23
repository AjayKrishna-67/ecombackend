import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Permission } from '@vendure/common/lib/generated-types';
import { Allow, Ctx, RequestContext, ID, Transaction } from '@vendure/core';
import { DeliveryPartnerService } from '../../../services/delivery-partner.service';
import { DeliveryFulfillmentService } from '../../../services/delivery-fulfillment.service';
import { DeliveryReportService } from '../../../services/delivery-report.service';
import { DeliveryQrCodeService } from '../../../services/delivery-qr-code.service';
import { DeliveryPaymentLinkService } from '../../../services/delivery-payment-link.service';
import { customFulfillmentPermission, outForDeliveryPermission, deliveredPermission, viewDeliveryReportsPermission } from '../../../permissions';

@Resolver()
export class CustomFulfillmentAdminResolver {
    constructor(
        private deliveryPartnerService: DeliveryPartnerService,
        private deliveryFulfillmentService: DeliveryFulfillmentService,
        private deliveryReportService: DeliveryReportService,
        private deliveryQrCodeService: DeliveryQrCodeService,
        private deliveryPaymentLinkService: DeliveryPaymentLinkService,
    ) {}

    // ─── Admin-only queries (require CustomFulfillment permission) ───

    @Query()
    @Allow(customFulfillmentPermission.Permission)
    async deliveryPersons(@Ctx() ctx: RequestContext) {
        return this.deliveryPartnerService.getDeliveryPersons(ctx);
    }

    @Query()
    @Allow(customFulfillmentPermission.Permission)
    async deliveryPerson(
        @Ctx() ctx: RequestContext,
        @Args() args: { id: ID },
    ) {
        return this.deliveryPartnerService.getDeliveryPerson(ctx, args.id);
    }

    @Query()
    @Allow(customFulfillmentPermission.Permission)
    async deliveryPersonFulfillments(
        @Ctx() ctx: RequestContext,
        @Args() args: { deliveryPersonId: ID },
    ) {
        return this.deliveryPartnerService.getFulfillmentsByDeliveryPerson(ctx, args.deliveryPersonId);
    }

    @Query()
    @Allow(customFulfillmentPermission.Permission)
    async deliveryOrders(
        @Ctx() ctx: RequestContext,
        @Args() args: { options?: {
            shippingMethodId?: ID;
            postalCode?: string;
            area?: string;
            skip?: number;
            take?: number;
            filter?: any;
            sort?: any;
            filterOperator?: any;
        } },
    ) {
        return this.deliveryPartnerService.getDeliveryOrders(ctx, args.options || {});
    }

    @Query()
    @Allow(Permission.ReadOrder)
    async orderDeliveryAssignments(
        @Ctx() ctx: RequestContext,
        @Args() args: { orderId: ID },
    ) {
        return this.deliveryPartnerService.getOrderDeliveryAssignments(ctx, args.orderId);
    }

    // ─── Delivery Person self-service queries ───

    @Query()
    @Allow(outForDeliveryPermission.Permission)
    async myDeliveryProfile(@Ctx() ctx: RequestContext) {
        return this.deliveryPartnerService.getMyDeliveryProfile(ctx);
    }

    @Query()
    @Allow(outForDeliveryPermission.Permission)
    async myDeliveryFulfillments(@Ctx() ctx: RequestContext) {
        return this.deliveryPartnerService.getMyDeliveryFulfillments(ctx);
    }

    @Query()
    @Allow(outForDeliveryPermission.Permission)
    async myDeliveryFulfillmentsWithPayment(@Ctx() ctx: RequestContext) {
        return this.deliveryPartnerService.getMyDeliveryFulfillmentsWithPayment(ctx);
    }

    @Query()
    @Allow(outForDeliveryPermission.Permission)
    async myDeliveryOrders(
        @Ctx() ctx: RequestContext,
        @Args() args: { options?: {
            shippingMethodId?: ID;
            postalCode?: string;
            area?: string;
            search?: string;
            skip?: number;
            take?: number;
            filter?: any;
            sort?: any;
            filterOperator?: any;
            deliveredSince?: Date;
        } },
    ) {
        return this.deliveryPartnerService.getMyDeliveryOrders(ctx, args.options || {});
    }

    // ─── Unified delivery report (role-aware) ───

    @Query()
    @Allow(outForDeliveryPermission.Permission, deliveredPermission.Permission, viewDeliveryReportsPermission.Permission, customFulfillmentPermission.Permission)
    async deliveryReport(
        @Ctx() ctx: RequestContext,
        @Args() args: {
            input: {
                dateFrom: Date;
                dateTo: Date;
                skip?: number;
                take?: number;
                deliveryPersonId?: ID;
            };
        },
    ) {
        return this.deliveryReportService.getDeliveryReport(ctx, args.input);
    }

    // ─── Admin-only mutation ───

    @Mutation()
    @Transaction()
    @Allow(customFulfillmentPermission.Permission)
    async createDeliveryFulfillment(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: { lines: Array<{ orderLineId: ID; quantity: number }>; deliveryPersonId: ID } },
    ) {
        return this.deliveryPartnerService.createDeliveryFulfillment(ctx, args.input);
    }

    // ─── Shared mutations (Admin + Delivery Person) ───

    @Mutation()
    @Transaction()
    @Allow(outForDeliveryPermission.Permission)
    async transitToOutForDelivery(
        @Ctx() ctx: RequestContext,
        @Args() args: { fulfillmentId: ID },
    ) {
        return this.deliveryFulfillmentService.transitionFulfillmentToState(ctx, args.fulfillmentId, 'OutforDelivery');
    }

    @Mutation()
    @Transaction()
    @Allow(deliveredPermission.Permission)
    async transitToDelivered(
        @Ctx() ctx: RequestContext,
        @Args() args: {
            fulfillmentId: ID;
            paymentCollection?: { paymentCollectionMethod: string; collectedAmount: number; collectionNote?: string };
        },
    ) {
        return this.deliveryFulfillmentService.transitionFulfillmentToState(
            ctx, args.fulfillmentId, 'Delivered', args.paymentCollection,
        );
    }

    // ─── QR Code Payment (Delivery Person + Admin) ───

    @Query()
    @Allow(deliveredPermission.Permission)
    async deliveryQrCode(
        @Ctx() ctx: RequestContext,
        @Args() args: { fulfillmentId: ID },
    ) {
        return this.deliveryQrCodeService.getQrCode(ctx, args.fulfillmentId);
    }

    @Mutation()
    @Transaction()
    @Allow(deliveredPermission.Permission)
    async generateDeliveryQrCode(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: { fulfillmentId: ID; cashAmount?: number } },
    ) {
        return this.deliveryQrCodeService.generateQrCode(ctx, args.input);
    }

    @Mutation()
    @Allow(deliveredPermission.Permission)
    async checkDeliveryQrStatus(
        @Ctx() ctx: RequestContext,
        @Args() args: { fulfillmentId: ID },
    ) {
        return this.deliveryQrCodeService.checkQrStatus(ctx, args.fulfillmentId);
    }

    @Mutation()
    @Transaction()
    @Allow(deliveredPermission.Permission)
    async closeDeliveryQrCode(
        @Ctx() ctx: RequestContext,
        @Args() args: { fulfillmentId: ID },
    ) {
        return this.deliveryQrCodeService.closeQrCode(ctx, args.fulfillmentId);
    }

    // ─── Payment Link (Delivery Person + Admin) ───

    @Mutation()
    @Transaction()
    @Allow(deliveredPermission.Permission)
    async createDeliveryPaymentLink(
        @Ctx() ctx: RequestContext,
        @Args() args: { input: { fulfillmentId: ID; customerPhone: string } },
    ) {
        return this.deliveryPaymentLinkService.createPaymentLink(ctx, args.input);
    }

    @Mutation()
    @Allow(deliveredPermission.Permission)
    async checkDeliveryPaymentLinkStatus(
        @Ctx() ctx: RequestContext,
        @Args() args: { fulfillmentId: ID },
    ) {
        return this.deliveryPaymentLinkService.checkPaymentLinkStatus(ctx, args.fulfillmentId);
    }

    @Mutation()
    @Transaction()
    @Allow(deliveredPermission.Permission)
    async cancelDeliveryPaymentLink(
        @Ctx() ctx: RequestContext,
        @Args() args: { fulfillmentId: ID },
    ) {
        return this.deliveryPaymentLinkService.cancelPaymentLink(ctx, args.fulfillmentId);
    }
}

import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import {
    ACTIVE_ORDER_INPUT_FIELD_NAME,
    ActiveOrderService,
    Allow,
    Ctx,
    Customer,
    CustomerGroup,
    CustomerService,
    FacetValue,
    ID,
    idsAreEqual,
    isGraphQlErrorResult,
    LanguageCode,
    OrderLine,
    OrderService,
    Permission,
    PluginCommonModule,
    ProductVariant,
    ProductVariantService,
    Promotion,
    PromotionService,
    RequestContext,
    Transaction,
    TransactionalConnection,
    UserInputError,
    VendurePlugin,
} from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import gql from 'graphql-tag';
import * as path from 'path';
import { In } from 'typeorm';

import { addCouponProductToOrder, couponUnitsOf, freeFromPromotionOf } from './coupon-product-lines';
import { DraftOrderCouponProductsResolver } from './draft-order-coupon-products.resolver';
import { FREE_FROM_PROMOTION_FIELD, FREE_PRODUCT_ACTION_CODE, freeProductAction } from './free-product-action';
import { ModifyOrderCouponProductsResolver } from './modify-order-coupon-products.resolver';
import { PRODUCTS_PERCENTAGE_DISCOUNT_CODE, productsPercentageDiscountAction } from './products-percentage-discount-action';

/** Every argument through which a promotion can name product variants. */
const PRODUCT_ARGS: Array<{ list: 'conditions' | 'actions'; code: string; arg: string }> = [
    { list: 'conditions', code: 'contains_products', arg: 'productVariantIds' },
    { list: 'conditions', code: 'buy_x_get_y_free', arg: 'variantIdsX' },
    { list: 'conditions', code: 'buy_x_get_y_free', arg: 'variantIdsY' },
    { list: 'actions', code: PRODUCTS_PERCENTAGE_DISCOUNT_CODE, arg: 'productVariantIds' },
    { list: 'actions', code: FREE_PRODUCT_ACTION_CODE, arg: 'productVariantIds' },
];

const schemaExtension = gql`
    extend type Customer {
        groups: [CustomerGroup!]!
    }

    type CouponCodeItem {
        promotion: Promotion!
        productVariants: [ProductVariant!]!
        facetValues: [FacetValue!]!
        customerGroup: CustomerGroup
    }

    type CoupcodesList {
        items: [CouponCodeItem!]!
        totalItems: Int!
    }

    extend type Query {
        getCouponCodeList: CoupcodesList!
    }

    extend type OrderLine {
        """
        Id of the promotion whose free product this line is, or null for an
        ordinary line. The storefront draws such a line as a free item that can
        only be removed, and the free_product action is what makes it free.
        """
        freeFromPromotion: ID
    }

    extend type Mutation {
        """
        Adds a promotion's free product to the active order as its own line,
        tagged with the promotion id so it is never merged with a line the
        customer added for the same product. The promotion must name that
        product in its free_product or products_percentage_discount action.
        Adds the units still due (the action's count for that product, minus
        any already on the tagged line); quantity, when given, can only lower
        that.
        """
        addFreeProductToOrder(productVariantId: ID!, promotionId: ID!, quantity: Int): UpdateOrderItemsResult!
    }
`;

const adminSchemaExtension = gql`
    extend type OrderLine {
        """Id of the promotion whose free product this line is, or null."""
        freeFromPromotion: ID
    }
`;

@Resolver('OrderLine')
export class OrderLineFreeFromPromotionResolver {
    @ResolveField()
    freeFromPromotion(@Parent() line: OrderLine): string | null {
        return freeFromPromotionOf(line);
    }
}

@Resolver()
export class FreeProductOrderResolver {
    constructor(
        private activeOrderService: ActiveOrderService,
        private orderService: OrderService,
        private promotionService: PromotionService,
    ) {}

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateOrder, Permission.Owner)
    async addFreeProductToOrder(
        @Ctx() ctx: RequestContext,
        @Args() args: { productVariantId: ID; promotionId: ID; quantity?: number | null },
    ) {
        const promotion = await this.promotionService.findOne(ctx, args.promotionId);
        if (!promotion) {
            throw new UserInputError(`No promotion with id "${String(args.promotionId)}"`);
        }
        if (couponUnitsOf(promotion, args.productVariantId) < 1) {
            throw new UserInputError(
                `Promotion "${promotion.couponCode ?? promotion.name}" does not give product variant ${String(args.productVariantId)} away`,
            );
        }
        const activeOrder = await this.activeOrderService.getActiveOrder(ctx, undefined, true);
        // Without a quantity the storefront gets every unit still due in one call.
        const result = await addCouponProductToOrder(
            ctx,
            this.orderService,
            activeOrder.id,
            promotion,
            args.productVariantId,
            args.quantity,
        );
        return result ?? activeOrder;
    }
}

/**
 * Vendure's removeOrderLine, except that a line no longer on the order is
 * answered with the order as it is, instead of "This order does not contain
 * an OrderLine with the id …": the line the storefront wants gone is gone.
 *
 * App builds up to 2.1.8 take a coupon's free lines out twice when the coupon
 * gives two or more products (OFFER300), and showed that error to the
 * customer on the second pass. A line of another order is still never touched.
 */
@Resolver()
export class RemoveOrderLineResolver {
    constructor(
        private activeOrderService: ActiveOrderService,
        private orderService: OrderService,
    ) {}

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateOrder, Permission.Owner)
    async removeOrderLine(
        @Ctx() ctx: RequestContext,
        @Args() args: { orderLineId: ID; [ACTIVE_ORDER_INPUT_FIELD_NAME]?: any },
    ) {
        const activeOrder = await this.activeOrderService.getActiveOrder(
            ctx,
            args[ACTIVE_ORDER_INPUT_FIELD_NAME],
            true,
        );
        const order = await this.orderService.findOne(ctx, activeOrder.id);
        if (order && !order.lines.some(line => idsAreEqual(line.id, args.orderLineId))) {
            return order;
        }
        return this.orderService.removeItemFromOrder(ctx, activeOrder.id, args.orderLineId);
    }
}

@Resolver()
export class CouponCodeResolver {
    constructor(
        private promotionService: PromotionService,
        private connection: TransactionalConnection,
        private productVariantService: ProductVariantService,
        private customerService: CustomerService,
    ) {}

    @Query()
    async getCouponCodeList(@Ctx() ctx: RequestContext) {
        const res = await this.promotionService.findAll(ctx, {
            take: 42,
            filter: { enabled: { eq: true } },
        });
        // Take-away promotions (automatic or couponed) are earned by choosing
        // the pickup shipping method, not by entering a code — keep them out
        // of the customer-facing coupon list.
        let visible = res.items.filter(
            p => !p.conditions?.some(c => c.code === 'take_away_shipping_selected'),
        );
        visible = await this.filterUsableByCustomer(ctx, visible);
        const items = await Promise.all(
            visible.map(async promotion => {
                const productVariants = await this.resolveProductVariants(ctx, promotion);
                const facetValues = await this.resolveFacetValues(ctx, promotion);
                const customerGroup = await this.resolveCustomerGroup(ctx, promotion);
                return { promotion, productVariants, facetValues, customerGroup };
            }),
        );
        return { items, totalItems: res.totalItems - (res.items.length - visible.length) };
    }

    // Hide promotions the customer can no longer use (per-customer / global
    // usage limits, expiry) — the same checks applyCouponCode runs at checkout,
    // so the list can never offer a coupon that checkout would reject.
    private async filterUsableByCustomer(ctx: RequestContext, promotions: Promotion[]): Promise<Promotion[]> {
        if (!ctx.activeUserId || !promotions.length) return promotions;
        const customer = await this.customerService.findOneByUserId(ctx, ctx.activeUserId);
        if (!customer) return promotions;
        const withCode = promotions.filter(p => !!p.couponCode);
        const withoutCode = promotions.filter(p => !p.couponCode);
        const [codeResults, exhaustedIds] = await Promise.all([
            Promise.all(
                withCode.map(p => this.promotionService.validateCouponCode(ctx, p.couponCode!, customer.id)),
            ),
            withoutCode.length
                ? this.promotionService.getExhaustedPromotionIds(ctx, withoutCode, customer.id)
                : Promise.resolve(new Set<string>()),
        ]);
        const usable = new Set<string>();
        withCode.forEach((p, i) => {
            if (!isGraphQlErrorResult(codeResults[i])) usable.add(p.id.toString());
        });
        withoutCode.forEach(p => {
            if (!exhaustedIds.has(p.id.toString())) usable.add(p.id.toString());
        });
        return promotions.filter(p => usable.has(p.id.toString()));
    }

    private async resolveProductVariants(ctx: RequestContext, promotion: any): Promise<ProductVariant[]> {
        const ids = new Set<string>();
        for (const ref of PRODUCT_ARGS) {
            for (const id of this.extractArgValues(promotion[ref.list], ref.code, ref.arg)) {
                ids.add(id);
            }
        }
        if (!ids.size) return [];
        return this.productVariantService.findByIds(ctx, [...ids]);
    }

    private async resolveCustomerGroup(ctx: RequestContext, promotion: any): Promise<CustomerGroup | null> {
        const groupId = this.extractArgValue(promotion.conditions, 'customer_group', 'customerGroupId');
        if (!groupId) return null;
        return this.connection.getRepository(ctx, CustomerGroup).findOne({ where: { id: groupId } });
    }

    private async resolveFacetValues(ctx: RequestContext, promotion: any): Promise<FacetValue[]> {
        const facetValueIds = this.extractArgValues(promotion.conditions, 'at_least_n_with_facets', 'facets');
        if (!facetValueIds.length) return [];
        return this.connection.getRepository(ctx, FacetValue).find({
            where: { id: In(facetValueIds) },
            relations: ['facet', 'facet.translations', 'translations'],
        });
    }

    private extractArgValue(operations: any[], code: string, argName: string): string | null {
        if (!operations?.length) return null;
        for (const op of operations) {
            if (op.code === code) {
                const arg = op.args?.find((a: any) => a.name === argName);
                return arg?.value ?? null;
            }
        }
        return null;
    }

    /** Ids named by [argName] of the first operation with [code], as strings. */
    private extractArgValues(operations: any[], code: string, argName: string): string[] {
        if (!operations?.length) return [];
        for (const op of operations) {
            if (op.code === code) {
                const arg = op.args?.find((a: any) => a.name === argName);
                if (arg?.value) return this.parseIds(arg.value).map(id => String(id));
            }
        }
        return [];
    }

    /** A JSON id list as stored in a promotion argument, e.g. "[153,14]" or '["153"]'. */
    private parseIds(value: string): Array<string | number> {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
}

@Resolver('Customer')
class CustomerGroupsResolver {
    constructor(private connection: TransactionalConnection) {}

    @ResolveField()
    async groups(@Ctx() ctx: RequestContext, @Parent() customer: Customer): Promise<CustomerGroup[]> {
        const found = await this.connection.getRepository(ctx, Customer).findOne({
            where: { id: customer.id },
            relations: ['groups'],
        });
        return found?.groups ?? [];
    }
}

@VendurePlugin({
    imports: [PluginCommonModule],
    compatibility: '^3.6.3',
    // Product search + count editor for the free_product action's products.
    dashboard: './dashboard/index.tsx',
    configuration: config => {
        config.customFields.Promotion.push({
            name: 'shouldApply',
            type: 'boolean',
            defaultValue: false,
        });
        // "Discount specified products by %" is replaced, under the same
        // code, by the version that discounts only the coupon's own unit (see
        // products-percentage-discount-action.ts). Two actions with one code
        // would make the admin's choice ambiguous, so core's is taken out.
        config.promotionOptions.promotionActions = [
            ...config.promotionOptions.promotionActions.filter(
                action => action.code !== PRODUCTS_PERCENTAGE_DISCOUNT_CODE,
            ),
            freeProductAction,
            productsPercentageDiscountAction,
        ];
        // The line a storefront adds for a promotion's free product carries the
        // promotion id here. It keeps that line apart from the customer's own
        // line of the same product (custom fields take part in line merging)
        // and tells the free_product action which line to make free.
        // Internal on purpose: an exposed custom field would turn
        // OrderLine.customFields from the JSON scalar every storefront already
        // queries into an object type, breaking those queries (the website
        // did). Clients read the tag through OrderLine.freeFromPromotion and
        // set it through addFreeProductToOrder, both additive.
        config.customFields.OrderLine.push({
            name: FREE_FROM_PROMOTION_FIELD,
            type: 'string',
            nullable: true,
            internal: true,
            public: false,
            label: [{ languageCode: LanguageCode.en, value: 'Free from promotion' }],
        });
        return config;
    },
    shopApiExtensions: {
        schema: schemaExtension,
        resolvers: [
            CouponCodeResolver,
            CustomerGroupsResolver,
            OrderLineFreeFromPromotionResolver,
            FreeProductOrderResolver,
            RemoveOrderLineResolver,
        ],
    },
    adminApiExtensions: {
        schema: adminSchemaExtension,
        // The two coupon-products resolvers override built-in mutations
        // (modifyOrder; removeDraftOrderLine and adjustDraftOrderLine), no schema change.
        resolvers: [OrderLineFreeFromPromotionResolver, ModifyOrderCouponProductsResolver, DraftOrderCouponProductsResolver],
    },
})
export class PromotionCodesPlugin {
    static UiExtensions: AdminUiExtension = {
        id: 'promotion-codes-ui',
        extensionPath: path.join(__dirname, 'ui'),
        providers: ['providers.ts'],
    };
}

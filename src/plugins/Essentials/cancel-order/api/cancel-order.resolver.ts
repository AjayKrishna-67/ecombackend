import { 
    Resolver, 
    Mutation, 
    Args 
} from '@nestjs/graphql';
import { 
    OrderService, 
    RequestContext, 
    Ctx, 
    Allow, 
    Permission, 
    ID, 
    EntityNotFoundError, 
    OrderState, 
    UserInputError 
} from '@vendure/core';

@Resolver()
export class CancelOrderResolver {
    constructor(private orderService: OrderService) {}

    @Mutation()
    @Allow(Permission.Owner) // Only the customer (Owner) can call this
    async requestOrderCancellation(
        @Ctx() ctx: RequestContext,
        @Args() args: { orderId: ID; reason: string }
    ) {
        // A. Verify the order exists
        const order = await this.orderService.findOne(ctx, args.orderId);
        if (!order) {
            throw new EntityNotFoundError('Order', args.orderId);
        }

        // B. Update the Custom Field FIRST
        await this.orderService.updateCustomFields(ctx, args.orderId, {
            cancellationReason: args.reason,
        });

        // C. Transition the State
        const transitionResult = await this.orderService.transitionToState(
            ctx,
            args.orderId,
            'CancellationRequested' as OrderState
        );

        // D. Handle Errors
        if (transitionResult instanceof Error) {
            throw new UserInputError(transitionResult.message);
        }

        return transitionResult;
    }

    @Mutation()
    @Allow(Permission.Owner)
    async otherInstructions(
        @Ctx() ctx: RequestContext, 
        @Args() args: { orderId: ID; value: string }
    ) {
        const order = await this.orderService.findOne(ctx, args.orderId);
        if (!order) {
            throw new EntityNotFoundError('Order', args.orderId);
        }
        
        return this.orderService.updateCustomFields(ctx, args.orderId, { 
            otherInstructions: args.value 
        });
    }
}
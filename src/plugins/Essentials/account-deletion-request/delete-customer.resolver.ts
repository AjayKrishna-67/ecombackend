import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
    Allow,
    Ctx,
    RequestContext,
    CustomerService,
    Permission,
    InternalServerError,
} from '@vendure/core';

interface AccountDeletionResponse {
    success: boolean;
    message: string;
}

interface AccountDeletionStatus {
    isDeletionRequested: boolean;
    reason: string | null;
}

@Resolver()
export class DeleteCustomerResolver {
    constructor(private customerService: CustomerService) {}

    @Query()
    @Allow(Permission.Owner)
    async accountDeletionStatus(@Ctx() ctx: RequestContext): Promise<AccountDeletionStatus> {
        const userId = ctx.activeUserId;
        if (!userId) {
            throw new InternalServerError('No active user found');
        }
        const customer = await this.customerService.findOneByUserId(ctx, userId);
        if (!customer) {
            throw new InternalServerError('Customer profile not found');
        }
        const customFields = customer.customFields as any;
        return {
            isDeletionRequested: customFields.isDeletionRequested || false,
            reason: customFields.deletionRequestReason || null,
        };
    }

    @Mutation()
    @Allow(Permission.Owner)
    async requestAccountDeletion(
        @Ctx() ctx: RequestContext,
        @Args('reason') reason?: string,
    ): Promise<AccountDeletionResponse> {
        const userId = ctx.activeUserId;
        if (!userId) {
            throw new InternalServerError('No active user found');
        }
        const customer = await this.customerService.findOneByUserId(ctx, userId);
        if (!customer) {
            throw new InternalServerError('Customer profile not found');
        }
        const customFields = customer.customFields as any;
        if (customFields.isDeletionRequested) {
            return { success: false, message: 'Account deletion has already been requested.' };
        }
        await this.customerService.update(ctx, {
            id: customer.id,
            customFields: {
                isDeletionRequested: true,
                deletionRequestReason: reason || '',
                deletionRequestedAt: new Date(),
            },
        });
        return {
            success: true,
            message: 'Account deletion requested successfully.',
        };
    }

    @Mutation()
    @Allow(Permission.Owner)
    async cancelAccountDeletion(@Ctx() ctx: RequestContext): Promise<AccountDeletionResponse> {
        const userId = ctx.activeUserId;
        if (!userId) {
            throw new InternalServerError('No active user found');
        }
        const customer = await this.customerService.findOneByUserId(ctx, userId);
        if (!customer) {
            throw new InternalServerError('Customer profile not found');
        }
        const customFields = customer.customFields as any;
        if (!customFields.isDeletionRequested) {
            return { success: false, message: 'No deletion request to cancel.' };
        }
        await this.customerService.update(ctx, {
            id: customer.id,
            customFields: {
                isDeletionRequested: false,
                deletionRequestReason: null,
                deletionRequestedAt: null,
            },
        });
        return { success: true, message: 'Account deletion request has been cancelled.' };
    }
}

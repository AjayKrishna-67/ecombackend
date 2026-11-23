// src/plugins/otpmechanism/resolver/current-user-entity.resolver.ts
import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Ctx, RequestContext, CustomerService, User, TransactionalConnection, Customer } from '@vendure/core';
import { IsNull } from 'typeorm';

@Resolver('CurrentUser')
export class CurrentUserEntityResolver {
    constructor(
        private customerService: CustomerService,
        private connection: TransactionalConnection
    ) {}

    @ResolveField()
    async customerId(@Ctx() ctx: RequestContext, @Parent() user: User) {
        // Use admin context to find customer across all channels
        // Shop context is channel-specific and might not find the customer
        const adminCtx = new RequestContext({
            apiType: 'admin',
            isAuthorized: true,
            authorizedAsOwnerOnly: false,
            channel: ctx.channel,
            languageCode: ctx.languageCode,
        });
        
        console.log('[CurrentUserEntityResolver] Looking for customer for user:', user.id);
        
        // Try using customerService first (should exclude deleted by default, but verify)
        let customer = await this.customerService.findOneByUserId(adminCtx, user.id);
        
        // Verify customer is not deleted (customerService should handle this, but double-check)
        if (customer) {
            if (customer.deletedAt) {
                console.log('[CurrentUserEntityResolver] Customer found but is deleted (deletedAt:', customer.deletedAt, '), returning null');
                return null;
            }
            console.log('[CurrentUserEntityResolver] Found customer via service:', customer.id);
            return customer.id;
        }
        
        // Fallback: Query database directly (only non-deleted customers)
        console.log('[CurrentUserEntityResolver] Customer not found via service, trying direct DB query...');
        const customerRepo = this.connection.getRepository(adminCtx, Customer);
        const customerByUser = await customerRepo.findOne({
            where: { 
                user: { id: user.id },
                deletedAt: IsNull() // Only non-deleted customers
            },
            relations: ['user']
        });
        
        if (customerByUser) {
            // Verify the user relationship is valid
            if (customerByUser.user && customerByUser.user.id === user.id) {
                console.log('[CurrentUserEntityResolver] Found customer via direct DB query:', customerByUser.id);
                return customerByUser.id;
            } else {
                console.warn('[CurrentUserEntityResolver] Customer found but user relationship is invalid');
            }
        }
        
        console.error('[CurrentUserEntityResolver] Customer not found for user:', user.id);
        return null;
    }
}
import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { DeletionResponse, MutationDeleteCustomerArgs, MutationDeleteCustomersArgs } from '@vendure/common/lib/generated-types';
import {
    Allow,
    Ctx,
    Customer,
    CustomerGroupService,
    CustomerService,
    ID,
    Logger,
    Permission,
    RequestContext,
    Transaction,
    TransactionalConnection,
    User,
} from '@vendure/core';
import { IsNull } from 'typeorm';

/**
 * Overrides the built-in admin `deleteCustomer` and `deleteCustomers` (no schema change).
 *
 * A customer whose login (User) is already soft-deleted while the customer is
 * still active could not be deleted: core softDelete deletes the customer, then
 * looks the User up and throws "No User with the id X could be found", which
 * rolls the whole delete back (customer 25077 / user 24964). Every Google or
 * Apple login for that person meanwhile creates a new account, because all their
 * lookups skip deleted users. The login is restored here inside the same
 * transaction so core deletes both rows as usual.
 *
 * Core also runs `deleteCustomers` with Promise.all on one transaction: when one
 * id fails, the others can still write after the ROLLBACK, which leaves exactly
 * this half-deleted state. They run one at a time here.
 */
@Resolver()
export class AdminDeleteCustomerResolver {
    constructor(
        private connection: TransactionalConnection,
        private customerService: CustomerService,
        private customerGroupService: CustomerGroupService,
    ) {}

    @Transaction()
    @Mutation()
    @Allow(Permission.DeleteCustomer)
    async deleteCustomer(@Ctx() ctx: RequestContext, @Args() args: MutationDeleteCustomerArgs): Promise<DeletionResponse> {
        return this.deleteOne(ctx, args.id);
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.DeleteCustomer)
    async deleteCustomers(@Ctx() ctx: RequestContext, @Args() args: MutationDeleteCustomersArgs): Promise<DeletionResponse[]> {
        const results: DeletionResponse[] = [];
        for (const id of args.ids) {
            results.push(await this.deleteOne(ctx, id));
        }
        return results;
    }

    /** Same steps as core's CustomerResolver.deleteCustomer, after restoring a deleted login. */
    private async deleteOne(ctx: RequestContext, id: ID): Promise<DeletionResponse> {
        await this.restoreDeletedUserOfActiveCustomer(ctx, id);
        const groups = await this.customerService.getCustomerGroups(ctx, id);
        for (const group of groups) {
            await this.customerGroupService.removeCustomersFromGroup(ctx, {
                customerGroupId: group.id,
                customerIds: [id],
            });
        }
        return this.customerService.softDelete(ctx, id);
    }

    private async restoreDeletedUserOfActiveCustomer(ctx: RequestContext, customerId: ID): Promise<void> {
        const customer = await this.connection
            .getRepository(ctx, Customer)
            .findOne({ where: { id: customerId, deletedAt: IsNull() }, relations: ['user'] });
        const user = customer?.user;
        if (!user?.deletedAt) {
            return;
        }
        await this.connection.getRepository(ctx, User).update({ id: user.id }, { deletedAt: null });
        Logger.warn(
            `Customer ${String(customerId)} was active but its user ${String(user.id)} was already deleted ` +
                `(${user.deletedAt.toISOString()}); deleting both now`,
            'AdminDeleteCustomerResolver',
        );
    }
}

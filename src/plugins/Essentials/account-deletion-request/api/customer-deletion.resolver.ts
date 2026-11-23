import { Query, Resolver, Args } from '@nestjs/graphql';
import {
    Ctx,
    Customer,
    RequestContext,
    TransactionalConnection,
    Permission,
    Allow,
} from '@vendure/core';

interface CustomerDeletionRequest {
    id: string;
    firstName: string;
    lastName: string;
    phoneNumber: string;
    emailAddress: string;
    reason: string;
    requestedDate: string;
}

@Resolver()
export class CustomerDeletionResolver {
    constructor(private connection: TransactionalConnection) {}

    @Query()
    @Allow(Permission.ReadCustomer)
    async customersWithDeletionRequest(
        @Ctx() ctx: RequestContext,
        @Args('skip') skip?: number,
        @Args('take') take?: number,
    ): Promise<{ items: CustomerDeletionRequest[]; totalItems: number }> {
        const actualTake = take ?? 10;
        const actualSkip = skip ?? 0;
        const customerRepo = this.connection.getRepository(ctx, Customer);
        const qb = customerRepo
            .createQueryBuilder('customer')
            .where('customer.deletedAt IS NULL')
            .andWhere('customer.customFieldsIsdeletionrequested = :isRequested', { isRequested: true })
            .orderBy('customer.customFieldsDeletionrequestedat', 'DESC');
        const totalItems = await qb.getCount();
        const candidates = await qb.skip(actualSkip).take(actualTake).getMany();
        const items = candidates.map(c => {
            const cf = c.customFields as any;
            const requestedAt = cf.deletionRequestedAt ? new Date(cf.deletionRequestedAt) : new Date();
            return {
                id: String(c.id),
                firstName: c.firstName || '',
                lastName: c.lastName || '',
                phoneNumber: c.phoneNumber || '',
                emailAddress: c.emailAddress || '',
                reason: cf.deletionRequestReason || '',
                requestedDate: requestedAt.toISOString(),
            };
        });
        return { items, totalItems };
    }
}

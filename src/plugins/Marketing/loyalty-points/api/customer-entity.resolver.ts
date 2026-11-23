import { Args, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Ctx, Customer, ListQueryBuilder, ListQueryOptions, RequestContext } from '@vendure/core';
import { LoyaltyPointsTransaction } from '../entities/loyalty-points-transaction.entity';
import { CustomerLoyaltyPointsTransactionsArgs, LoyaltyPointsTransactionListOptions } from '../gql/generated';

@Resolver('Customer')
export class CustomerEntityResolver {
  constructor(private listQueryBuilder: ListQueryBuilder) {}

  @ResolveField()
  loyaltyPointsTransactions(
    @Ctx() ctx: RequestContext,
    @Parent() customer: Customer,
    @Args() { options }: CustomerLoyaltyPointsTransactionsArgs,
  ) {
    const queryOptions: ListQueryOptions<LoyaltyPointsTransaction> | undefined = options
      ? {
          skip: options.skip ?? undefined,
          take: options.take ?? undefined,
          sort: options.sort ?? undefined,
          filter: options.filter ?? undefined,
          filterOperator: options.filterOperator ?? undefined,
        }
      : undefined;

    return this.listQueryBuilder
      .build(LoyaltyPointsTransaction, queryOptions, {
        where: {
          customer: { id: customer.id },
          channels: { id: ctx.channelId },
        },
        relations: ['order'],
        channelId: ctx.channelId,
      })
      .getManyAndCount()
      .then(([items, totalItems]) => ({
        items,
        totalItems,
      }));
  }
}
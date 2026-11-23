import { Resolver, Mutation, Args } from '@nestjs/graphql';
import { Ctx, RequestContext, TransactionalConnection, ID } from '@vendure/core';

@Resolver()
export class StockManagerResolver {
  constructor(private connection: TransactionalConnection) {}

  @Mutation()
  async deleteStockLevel(
    @Ctx() ctx: RequestContext,
    @Args('productVariantId') productVariantId: ID,
    @Args('stockLocationId') stockLocationId: ID,
  ): Promise<boolean> {
    // Find and delete the specific StockLevel row
    const result = await this.connection
      .getRepository(ctx, 'StockLevel')
      .delete({
        productVariantId: productVariantId,
        stockLocationId: stockLocationId,
      });

    return result.affected ? result.affected > 0 : false;
  }
}


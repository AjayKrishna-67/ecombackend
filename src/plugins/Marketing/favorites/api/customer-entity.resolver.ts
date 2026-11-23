import { Parent, Args, ResolveField, Resolver } from '@nestjs/graphql';
import { Ctx, Customer, RequestContext } from '@vendure/core';
import { FavoritesService } from '../services/favorites.service';
import { CustomerFavoritesArgs } from '../generated-shop-types';

@Resolver('Customer')
export class CustomerEntityResolver {
    constructor(private favoritesService: FavoritesService) {}

    @ResolveField()
    async favorites(
        @Parent() customer: Customer,
        @Ctx() ctx: RequestContext,
        @Args() args: CustomerFavoritesArgs,
    ) {
        return this.favoritesService.findAllWithFilter(
            ctx,
            customer.id,
            args.options || undefined,
            args.productNameFilter || undefined,
        );
    }
}

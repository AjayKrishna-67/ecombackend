import { Injectable, Scope } from '@nestjs/common';
import { ID, ProductVariant, RequestContext } from '@vendure/core';
import DataLoader from 'dataloader';
import { CartValidationService } from '../services/cart-validation.service';

/**
 * Request-scoped DataLoader for the variants behind `OrderLine.isAvailable` /
 * `OrderLine.unavailableReason`.
 *
 * Without it, each of those two fields fired its own variant + stock-level join
 * for every line: a 10-line cart selecting both fields = 20 queries, all for
 * variants already known up front. The loader collects every variant id asked
 * for within a tick, dedupes them and issues ONE `WHERE id IN (...)` query. It is
 * scoped to the request (Scope.REQUEST), the same as AddonGroupDataLoader, so its
 * cache never outlives the request or crosses channels.
 */
@Injectable({ scope: Scope.REQUEST })
export class AvailabilityVariantDataLoader {
    private loader: DataLoader<ID, ProductVariant | undefined> | undefined;

    constructor(private readonly cartValidationService: CartValidationService) {}

    getLoader(ctx: RequestContext): DataLoader<ID, ProductVariant | undefined> {
        if (!this.loader) {
            this.loader = new DataLoader<ID, ProductVariant | undefined>(
                async ids => {
                    const variants = await this.cartValidationService.findVariantsForAvailability(ctx, ids as ID[]);
                    const variantById = new Map(variants.map(variant => [String(variant.id), variant]));
                    // DataLoader contract: return array MUST match the input order and length.
                    return ids.map(id => variantById.get(String(id)));
                },
                { cacheKeyFn: id => String(id) },
            );
        }
        return this.loader;
    }
}

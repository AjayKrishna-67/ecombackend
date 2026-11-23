import { api, Badge, PageContextValue } from '@vendure/dashboard';
import { useQuery } from '@tanstack/react-query';
import { Package } from 'lucide-react';
import React from 'react';

import { displayUnitForBase, poolUnitLabel } from '../../shared/pool-measure';
import { fromBase } from '../../shared/stock-units';
import {
    ProductStockOverview,
    productStockLevelsDocument,
    productStockOverviewDocument,
    variantPoolContextDocument,
} from './queries';

/**
 * Banner shown above the Stock box on the variant page of a pooled product.
 *
 * The box below it stays editable — replacing the core Stock block outright
 * would mean re-implementing the per-variant editor that the other ~300
 * non-pooled products still need, and a block extension cannot render the core
 * one conditionally. So the server now snaps the mirror back on save (see
 * ProductStockPlugin.restoreMirrorAfterVariantEdits) and this explains, before
 * the typing starts, why the number will not stay.
 *
 * Renders nothing at all unless this product is genuinely pooled: toggle on AND
 * a pool row present, the same pair shared/is-pooled.ts defines for the server.
 */
export function VariantPoolNotice({ context }: { context: PageContextValue }) {
    const variantId = context.entity?.id ? String(context.entity.id) : undefined;

    const variantQuery = useQuery({
        queryKey: ['variant-pool-context', variantId],
        queryFn: () => api.query(variantPoolContextDocument, { id: variantId! }),
        enabled: !!variantId,
    });
    const productId = (variantQuery.data as any)?.productVariant?.product?.id
        ? String((variantQuery.data as any).productVariant.product.id)
        : undefined;
    const productName: string = (variantQuery.data as any)?.productVariant?.product?.name ?? '';
    const toggleOn = !!(variantQuery.data as any)?.productVariant?.product?.customFields
        ?.productStockEnabled;

    const levelsQuery = useQuery({
        queryKey: ['product-stock-levels', productId],
        queryFn: () => api.query(productStockLevelsDocument, { productId: productId! }),
        enabled: !!productId && toggleOn,
    });
    const overviewQuery = useQuery({
        queryKey: ['product-stock-overview', productId],
        queryFn: () => api.query(productStockOverviewDocument, { productId: productId! }),
        enabled: !!productId && toggleOn,
    });

    const hasPoolRow = ((levelsQuery.data as any)?.productStockLevels ?? []).length > 0;
    if (!toggleOn || !hasPoolRow) {
        return null;
    }

    const overview: ProductStockOverview | undefined = (overviewQuery.data as any)?.productStockOverview;
    const baseUnit = (overview?.baseUnit ?? 'g') as 'g' | 'ml' | 'piece';
    const label = poolUnitLabel(baseUnit);
    const displayUnit = displayUnitForBase(baseUnit);
    const available = overview ? fromBase(Math.max(0, overview.availableWeight), displayUnit) : null;
    const thisVariant = overview?.variants.find(v => String(v.variantId) === String(variantId));

    return (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 mb-4">
            <div className="flex items-start gap-3">
                <Package className="h-5 w-5 mt-0.5 shrink-0" />
                <div className="space-y-2">
                    <div className="font-medium">Stock for this variant comes from the product pool</div>
                    <p className="text-sm text-muted-foreground">
                        {productName ? `"${productName}"` : 'This product'} tracks one shared pool for the
                        whole product, and each variant draws from it by its measured size. The Stock levels
                        box below is a <strong>read-out of that pool</strong>: anything typed there is
                        replaced with the pool's own figure when you save, and shoppers are never shown it.
                        To change what is in stock, edit <strong>Product-Level Stock</strong> on the product
                        page.
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                        {available != null && (
                            <Badge variant="secondary">
                                Pool available: {available} {label}
                            </Badge>
                        )}
                        {thisVariant && (
                            <Badge variant="secondary">
                                This variant: {thisVariant.availableStock} saleable
                                {thisVariant.stockAllocated > 0
                                    ? ` · ${thisVariant.stockAllocated} reserved`
                                    : ''}
                            </Badge>
                        )}
                        {/* A plain anchor, not <Button asChild>: this Button does
                            not accept asChild in the version pinned here. */}
                        {productId && (
                            <a
                                href={`/dashboard/products/${productId}`}
                                className="text-sm font-medium underline underline-offset-4"
                            >
                                Open product stock
                            </a>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

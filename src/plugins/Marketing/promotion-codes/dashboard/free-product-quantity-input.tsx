import { useQuery } from '@tanstack/react-query';
import { api, Button, DefaultRelationInput, graphql, Input } from '@vendure/dashboard';
import { Minus, Plus, X } from 'lucide-react';
import React from 'react';

const freeVariantsDocument = graphql(`
    query FreeProductVariants($ids: [String!]!) {
        productVariants(options: { filter: { id: { in: $ids } }, take: 100 }) {
            items {
                id
                name
                sku
                featuredAsset {
                    preview
                }
                product {
                    featuredAsset {
                        preview
                    }
                }
            }
        }
    }
`);

/** id → count, first-seen order kept. The value lists an id once per free unit. */
function countsOf(value: unknown): Map<string, number> {
    const counts = new Map<string, number>();
    for (const item of Array.isArray(value) ? value : []) {
        const id = String(typeof item === 'object' && item ? (item as any).id : item);
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
}

function idsOf(counts: Map<string, number>): string[] {
    const ids: string[] = [];
    counts.forEach((count, id) => {
        for (let i = 0; i < count; i++) ids.push(id);
    });
    return ids;
}

/**
 * Editor for the free_product action's `productVariantIds`: search to add a
 * product, then a count box per product. The count is stored by repeating
 * the id, so "2 x Onion" is ["1278","1278"]; the server gives away one unit
 * per listing. Same behaviour as the Angular admin's component in ui/.
 */
export function FreeProductQuantityInput(props: any) {
    const { value, onChange, disabled, fieldDef } = props;
    const counts = countsOf(value);
    const ids = [...counts.keys()];

    const { data } = useQuery({
        queryKey: ['free-product-variants', ids.join(',')],
        queryFn: () => api.query(freeVariantsDocument, { ids }),
        enabled: ids.length > 0,
    });
    const byId = new Map<string, any>(((data as any)?.productVariants?.items ?? []).map((v: any) => [String(v.id), v]));

    const write = (next: Map<string, number>) => onChange(idsOf(next));
    const setQuantity = (id: string, raw: number | string) => {
        const next = new Map(counts);
        next.set(id, Math.max(1, Math.floor(Number(raw) || 1)));
        write(next);
    };
    const remove = (id: string) => {
        const next = new Map(counts);
        next.delete(id);
        write(next);
    };
    const add = (id: unknown) => {
        if (id == null || id === '') return;
        const key = String(typeof id === 'object' ? (id as any).id : id);
        const next = new Map(counts);
        next.set(key, (next.get(key) ?? 0) + 1);
        write(next);
    };

    return (
        <div className="space-y-2">
            {ids.map(id => {
                const v = byId.get(id);
                const preview = v?.featuredAsset?.preview ?? v?.product?.featuredAsset?.preview;
                const quantity = counts.get(id) ?? 1;
                return (
                    <div key={id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                        {preview ? (
                            <img src={`${preview}?preset=tiny`} alt="" className="h-8 w-8 rounded object-cover" />
                        ) : null}
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{v?.name ?? `Variant ${id}`}</div>
                            {v?.sku ? <div className="text-xs text-muted-foreground">{v.sku}</div> : null}
                        </div>
                        <div className="flex items-center gap-1">
                            <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-8 w-8"
                                disabled={disabled || quantity <= 1}
                                onClick={() => setQuantity(id, quantity - 1)}
                            >
                                <Minus className="h-3.5 w-3.5" />
                            </Button>
                            <Input
                                type="number"
                                min={1}
                                step={1}
                                className="h-8 w-16 text-center"
                                value={quantity}
                                disabled={disabled}
                                onChange={e => setQuantity(id, e.target.value)}
                            />
                            <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-8 w-8"
                                disabled={disabled}
                                onClick={() => setQuantity(id, quantity + 1)}
                            >
                                <Plus className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                        {!disabled ? (
                            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => remove(id)}>
                                <X className="h-4 w-4" />
                            </Button>
                        ) : null}
                    </div>
                );
            })}
            {!disabled ? (
                <DefaultRelationInput
                    {...props}
                    fieldDef={{ ...(fieldDef ?? {}), list: false }}
                    entityType="ProductVariant"
                    value=""
                    onChange={add}
                />
            ) : null}
        </div>
    );
}

FreeProductQuantityInput.metadata = { isListInput: true };

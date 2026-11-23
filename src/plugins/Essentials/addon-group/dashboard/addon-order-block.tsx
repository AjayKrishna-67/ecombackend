import { api, Badge, PageContextValue, Spinner, useLocalFormat } from '@vendure/dashboard';
import { useQuery } from '@tanstack/react-query';
import React from 'react';
import {
    AddonSelectionItemDto,
    getOrderAddonSelectionsDocument,
    OrderLineWithAddonsDto,
} from './queries';

/**
 * Order-detail page block showing per-line addon selections and the order's addon
 * total. Replaces the old Angular CustomDetailComponent that hacked chips into the
 * line-item table via a MutationObserver — here it's a clean, declarative block.
 */
export function AddonOrderBlock({ context }: { context: PageContextValue }) {
    const { formatCurrency } = useLocalFormat();
    const orderId = context.entity?.id ? String(context.entity.id) : undefined;

    const { data, isLoading } = useQuery({
        queryKey: ['order-addon-selections', orderId],
        queryFn: () => api.query(getOrderAddonSelectionsDocument, { id: orderId! }),
        enabled: !!orderId,
    });

    const order = (data as any)?.order;
    const currency: string = order?.currencyCode ?? 'USD';
    const addonsTotal: number = order?.addonsTotal ?? 0;
    const lines: OrderLineWithAddonsDto[] = (order?.lines ?? []).filter(
        (l: OrderLineWithAddonsDto) => l.addonSelections && l.addonSelections.length > 0,
    );

    if (isLoading) {
        return (
            <div className="flex justify-center p-4">
                <Spinner />
            </div>
        );
    }
    // No addons anywhere on the order — render nothing to avoid an empty block.
    if (lines.length === 0) {
        return null;
    }

    const allItems = (line: OrderLineWithAddonsDto): AddonSelectionItemDto[] =>
        line.addonSelections.flatMap(g => g.items);
    const lineTotal = (line: OrderLineWithAddonsDto): number =>
        allItems(line).reduce((sum, it) => sum + (it.unitPrice || 0) * (it.quantity || 0), 0);

    return (
        <div className="divide-border overflow-hidden rounded-md border">
            {lines.map(line => {
                const items = allItems(line);
                const perUnit = lineTotal(line);
                return (
                    <div key={line.id} className="space-y-2 px-4 py-3">
                        <div className="flex items-center gap-2">
                            <span
                                className={`text-sm font-medium ${
                                    line.addonsAvailable === false ? 'text-muted-foreground line-through' : ''
                                }`}
                            >
                                {line.productVariant.name}
                            </span>
                            {line.addonsAvailable === false && (
                                <Badge variant="destructive" className="text-[10px] uppercase">
                                    Out of stock
                                </Badge>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                            {items.map(it => {
                                const qty = it.quantity > 1 ? ` ×${it.quantity}` : '';
                                const price = it.unitPrice
                                    ? ` · ${formatCurrency(it.unitPrice * (it.quantity || 0), currency)}`
                                    : '';
                                return (
                                    <span
                                        key={it.itemId}
                                        title={it.enabled === false ? 'Out of stock' : undefined}
                                        className={`bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs whitespace-nowrap ${
                                            it.enabled === false ? 'line-through opacity-70' : ''
                                        }`}
                                    >
                                        {it.itemName}
                                        {qty}
                                        {price}
                                        {it.enabled === false ? ' — Out of stock' : ''}
                                    </span>
                                );
                            })}
                            {perUnit > 0 && (
                                <span
                                    title="Addon total per unit (included in the line price)"
                                    className="text-primary bg-primary/10 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap"
                                >
                                    +{formatCurrency(perUnit, currency)}
                                </span>
                            )}
                        </div>
                    </div>
                );
            })}
            <div className="bg-muted/50 flex items-center justify-between border-t px-4 py-3">
                <span className="text-sm font-semibold">Addons total</span>
                <span className="text-primary text-sm font-bold">{formatCurrency(addonsTotal, currency)}</span>
            </div>
        </div>
    );
}

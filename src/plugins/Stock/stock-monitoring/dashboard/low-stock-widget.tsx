import {
    api,
    Badge,
    Button,
    DashboardBaseWidget,
    Spinner,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@vendure/dashboard';
import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { LowStockVariant, lowStockDocument } from './queries';

const PAGE_SIZE = 10;

function totalStock(stockLevels: Array<{ stockOnHand: number }>): number {
    return (stockLevels ?? []).reduce((sum, level) => sum + (level.stockOnHand ?? 0), 0);
}

export function LowStockWidget() {
    const [page, setPage] = useState(0);
    const { data, isLoading, isError } = useQuery({
        queryKey: ['low-stock-variants', page],
        queryFn: () => api.query(lowStockDocument, { skip: page * PAGE_SIZE, take: PAGE_SIZE }),
    });

    const result = (data as any)?.productVariantsWithLowStock;
    const items: LowStockVariant[] = result?.items ?? [];
    const totalItems: number = result?.totalItems ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));

    return (
        <DashboardBaseWidget
            id="low-stock-widget"
            title="Low stock"
            description="Variants at or below the low-stock threshold"
        >
            {isLoading ? (
                <div className="flex justify-center p-6">
                    <Spinner />
                </div>
            ) : isError ? (
                <div className="text-destructive p-4 text-sm">Failed to load low-stock variants.</div>
            ) : items.length === 0 ? (
                <div className="text-muted-foreground p-6 text-center text-sm">
                    No variants are low on stock.
                </div>
            ) : (
                <div className="space-y-3">
                    <div className="max-h-72 overflow-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Variant</TableHead>
                                    <TableHead className="text-right">Stock</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {items.map(variant => {
                                    const total = totalStock(variant.stockLevels);
                                    const critical = total < 10;
                                    return (
                                        <TableRow key={variant.id}>
                                            <TableCell>
                                                <a
                                                    className="text-primary hover:underline"
                                                    href={`/dashboard/product-variants/${variant.id}`}
                                                >
                                                    {variant.name}
                                                </a>
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <Badge variant={critical ? 'destructive' : 'warning'}>
                                                    {total}
                                                </Badge>
                                            </TableCell>
                                        </TableRow>
                                    );
                                })}
                            </TableBody>
                        </Table>
                    </div>
                    {totalPages > 1 && (
                        <div className="flex items-center justify-between text-sm">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={page === 0}
                                onClick={() => setPage(p => Math.max(0, p - 1))}
                            >
                                Previous
                            </Button>
                            <span className="text-muted-foreground">
                                Page {page + 1} of {totalPages}
                            </span>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={page + 1 >= totalPages}
                                onClick={() => setPage(p => p + 1)}
                            >
                                Next
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </DashboardBaseWidget>
    );
}

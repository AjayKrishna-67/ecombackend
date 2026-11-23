import {
    api,
    Badge,
    Button,
    Input,
    Label,
    PageContextValue,
    PaginatedListDataTableKey,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Spinner,
    Switch,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Package, Plus, RefreshCw, Store, Trash2, X } from 'lucide-react';
// Check still used in the Add-Location form Save button
import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
    ProductStockLevel,
    ProductStockOverview,
    StockLocationOption,
    productStockLevelsDocument,
    productStockOverviewDocument,
    removeProductStockDocument,
    resyncProductStockDocument,
    setProductStockDocument,
    setProductStockEnabledDocument,
    stockLocationsDocument,
} from './queries';

// Base<->display math lives in the shared stock-units module (Issue 3: one
// source of truth); which unit a given product's pool uses comes from
// pool-measure, the same module the backend divides by.
import { fromBase, toBase } from '../../shared/stock-units';
import { displayUnitForBase, poolInputStep, poolUnitLabel } from '../../shared/pool-measure';

export function ProductStockBlock({ context }: { context: PageContextValue }) {
    const productId = context.entity?.id ? String(context.entity.id) : undefined;
    const queryClient = useQueryClient();
    const levelsKey = ['product-stock-levels', productId];
    const overviewKey = ['product-stock-overview', productId];

    const [editValues, setEditValues] = useState<Record<string, string>>({});
    const [showAdd, setShowAdd] = useState(false);
    const [addLocationId, setAddLocationId] = useState('');
    const [addStock, setAddStock] = useState('0');
    // The toggle is the `productStockEnabled` Product custom field, which the
    // backend strategy reads to choose product-level vs per-variant stock.
    //
    // It writes through its own mutation (see handleToggle) rather than riding
    // on the page form. The form is still used to READ the current value and to
    // keep it in step after a write, so the page does not later submit a stale
    // one -- but the form is no longer what persists it.
    const form = context.form;

    const locationsQuery = useQuery({
        queryKey: ['stock-locations'],
        queryFn: () => api.query(stockLocationsDocument, {}),
    });
    const levelsQuery = useQuery({
        queryKey: levelsKey,
        queryFn: () => api.query(productStockLevelsDocument, { productId: productId! }),
        enabled: !!productId,
    });
    const overviewQuery = useQuery({
        queryKey: overviewKey,
        queryFn: () => api.query(productStockOverviewDocument, { productId: productId! }),
        enabled: !!productId,
    });

    const locations: StockLocationOption[] = (locationsQuery.data as any)?.stockLocations?.items ?? [];
    const levels: ProductStockLevel[] = (levelsQuery.data as any)?.productStockLevels ?? [];
    const overview: ProductStockOverview | null =
        (overviewQuery.data as any)?.productStockOverview ?? null;

    // The pool's unit is a property of the product's option group, resolved
    // server-side and reported on the overview. Falling back to grams while the
    // query is in flight keeps a weight product rendering exactly as it always
    // has instead of flickering through a piece label.
    const baseUnit = (overview?.baseUnit as 'g' | 'ml' | 'piece') ?? 'g';
    const displayUnit = displayUnitForBase(baseUnit);
    const unitLabel = poolUnitLabel(baseUnit);
    const inputStep = poolInputStep(baseUnit);
    const toDisplay = (base: number) => fromBase(base, displayUnit);
    const toStorage = (display: number) => toBase(display, displayUnit);

    useEffect(() => {
        const seeded: Record<string, string> = {};
        for (const level of levels) {
            seeded[level.stockLocationId] = String(toDisplay(level.stockOnHand));
        }
        setEditValues(seeded);
    }, [levelsQuery.data, baseUnit]);

    /**
     * Refetches everything a pool edit changes, without reloading the page.
     *
     * The third invalidation is the one that stops the hard refresh: the
     * variants table further down the product page is a PaginatedListDataTable
     * owned by the Dashboard, not by this block, so invalidating only this
     * block's own queries left that table showing pre-edit stock until the
     * browser refetched everything.
     *
     * `setProductStock` recomputes each variant's StockLevel inside the
     * mutation, so by the time it resolves the new numbers are already in the
     * database and a refetch is guaranteed to see them -- no polling, no delay.
     *
     * The key is a PREFIX. TanStack matches it against every query whose key
     * starts with it, which is how one line reaches a table this component
     * holds no reference to. Dashboard core invalidates its own tables the same
     * way (see customer-group-members-table).
     */
    function refresh() {
        queryClient.invalidateQueries({ queryKey: levelsKey });
        queryClient.invalidateQueries({ queryKey: overviewKey });
        queryClient.invalidateQueries({ queryKey: [PaginatedListDataTableKey] });
    }

    const setStockMutation = useMutation({
        mutationFn: (vars: { stockLocationId: string; amount: number }) =>
            api.mutate(setProductStockDocument, {
                input: {
                    productId: productId!,
                    stockLocationId: vars.stockLocationId,
                    stockOnHand: toStorage(vars.amount),
                },
            }),
        onSuccess: () => {
            toast.success('Product stock updated');
            setShowAdd(false);
            setAddLocationId('');
            setAddStock('0');
            refresh();
        },
        onError: (err: Error) => toast.error(`Failed: ${err?.message ?? 'Unknown error'}`),
    });

    const removeMutation = useMutation({
        mutationFn: () => api.mutate(removeProductStockDocument, { productId: productId! }),
        onSuccess: () => {
            toast.success('Product stock removed');
            refresh();
        },
        onError: (err: Error) => toast.error(`Failed: ${err?.message ?? 'Unknown error'}`),
    });

    const resyncMutation = useMutation({
        mutationFn: () => api.mutate(resyncProductStockDocument, { productId: productId! }),
        onSuccess: () => {
            toast.success('Variant stock levels re-synced');
            refresh();
        },
        onError: (err: Error) => toast.error(`Re-sync failed: ${err?.message ?? 'Unknown error'}`),
    });

    // Persists the toggle immediately rather than waiting for the page's Update
    // button. Binding it to the page form alone meant the switch could read "on"
    // while the database said off -- and the backend strategy reads the
    // database, so the weight pool was silently bypassed.
    //
    // Declared here with the other mutations, ABOVE the `if (!productId)` early
    // return: useMutation is a hook, and a hook after a conditional return
    // changes the hook order between renders.
    const enabledMutation = useMutation({
        mutationFn: (next: boolean) =>
            api.mutate(setProductStockEnabledDocument, { id: productId!, enabled: next }),
        onSuccess: (_data, next) => {
            // Keep the page form in step so the value is not reported as an
            // unsaved change, and so a later Update does not write back the old one.
            form?.setValue('customFields.productStockEnabled', next, { shouldDirty: false });
            queryClient.invalidateQueries({ queryKey: levelsKey });
            queryClient.invalidateQueries({ queryKey: overviewKey });
            toast.success(next ? 'Product-level stock enabled' : 'Product-level stock disabled');
        },
        onError: (err, next) => {
            // Snap the switch back: the database did not change.
            form?.setValue('customFields.productStockEnabled', !next, { shouldDirty: false });
            toast.error('Could not change product-level stock', {
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        },
    });

    if (!productId) return null;

    const usedIds = new Set(levels.map(l => String(l.stockLocationId)));
    const availableLocations = locations.filter(loc => !usedIds.has(String(loc.id)));
    const locationName = (id: string) =>
        locations.find(l => String(l.id) === String(id))?.name ?? `Location #${id}`;
    const saving =
        setStockMutation.isPending ||
        removeMutation.isPending ||
        resyncMutation.isPending ||
        enabledMutation.isPending;
    const loading = levelsQuery.isLoading || overviewQuery.isLoading;
    const enabled = !!form?.watch('customFields.productStockEnabled');

    function handleToggle(next: boolean) {
        if (!productId) return;
        // Optimistic, so the switch responds at once; onError puts it back.
        form?.setValue('customFields.productStockEnabled', next, { shouldDirty: false });
        if (!next) setShowAdd(false);
        enabledMutation.mutate(next);
    }

    return (
        <div className="divide-border divide-y">
            {/* ── Product-Level Stock toggle ─────────────── */}
            <section className="flex items-start justify-between gap-4 pb-5">
                <div className="space-y-1">
                    <h3 className="text-sm font-semibold">Product-Level Stock</h3>
                    <p className="text-muted-foreground max-w-xl text-sm">
                        Track one stock pool for the whole product; variants draw from it by their measured size.
                        When off, standard per-variant Vendure stock is used.
                    </p>
                </div>
                <Switch checked={enabled} disabled={saving || !productId} onCheckedChange={handleToggle} />
            </section>

            {!enabled && (
                <section className="text-muted-foreground py-5 text-sm">
                    Product-level stock is off. This product uses standard per-variant Vendure stock.
                    Turn it on to manage a shared weight pool — the switch saves on its own, no
                    need to click Update.
                </section>
            )}

            {enabled && (
            <>
            {/* ── Stock Levels ───────────────────────────── */}
            <section className="space-y-3 pb-5">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Store className="text-muted-foreground h-4 w-4" />
                        <h3 className="text-sm font-semibold">Stock Levels</h3>
                    </div>
                    {levels.length > 0 && !showAdd && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={saving}
                            onClick={() => removeMutation.mutate()}
                        >
                            <Trash2 className="mr-1.5 h-4 w-4" />
                            Remove all stock
                        </Button>
                    )}
                </div>

                {loading ? (
                    <div className="flex justify-center p-6">
                        <Spinner />
                    </div>
                ) : (
                    <>
                        {levels.length > 0 && (
                            <div className="overflow-hidden rounded-lg border">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="bg-muted/50 hover:bg-muted/50">
                                            <TableHead>Location</TableHead>
                                            <TableHead className="text-right">Allocated</TableHead>
                                            <TableHead className="w-[240px]">On hand ({unitLabel})</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {levels.map(level => {
                                            const dirty =
                                                String(editValues[level.stockLocationId] ?? '') !==
                                                String(toDisplay(level.stockOnHand));
                                            return (
                                            <TableRow key={level.stockLocationId}>
                                                <TableCell>
                                                    <div className="flex items-center gap-2">
                                                        <span className="bg-primary/10 text-primary flex h-6 w-6 items-center justify-center rounded-full">
                                                            <Store className="h-3.5 w-3.5" />
                                                        </span>
                                                        <span className="font-medium">
                                                            {locationName(level.stockLocationId)}
                                                        </span>
                                                    </div>
                                                </TableCell>
                                                <TableCell className="text-right tabular-nums font-semibold">
                                                    {toDisplay(level.stockAllocated)} {unitLabel}
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex items-center gap-2">
                                                        <Input
                                                            type="number"
                                                            min="0"
                                                            step={inputStep}
                                                            className="h-8"
                                                            disabled={saving}
                                                            value={editValues[level.stockLocationId] ?? ''}
                                                            onChange={e =>
                                                                setEditValues(prev => ({
                                                                    ...prev,
                                                                    [level.stockLocationId]: e.target.value,
                                                                }))
                                                            }
                                                            onKeyDown={e => {
                                                                if (e.key === 'Enter' && dirty) {
                                                                    setStockMutation.mutate({
                                                                        stockLocationId: level.stockLocationId,
                                                                        amount: Number(editValues[level.stockLocationId] ?? 0),
                                                                    });
                                                                }
                                                            }}
                                                        />
                                                        {dirty && (
                                                            <Button
                                                                variant="default"
                                                                size="icon"
                                                                className="h-8 w-8 shrink-0"
                                                                title="Save stock"
                                                                disabled={saving}
                                                                onClick={() =>
                                                                    setStockMutation.mutate({
                                                                        stockLocationId: level.stockLocationId,
                                                                        amount: Number(editValues[level.stockLocationId] ?? 0),
                                                                    })
                                                                }
                                                            >
                                                                <Check className="h-4 w-4" />
                                                            </Button>
                                                        )}
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                            );
                                        })}
                                    </TableBody>
                                </Table>
                            </div>
                        )}

                        {levels.length === 0 && !showAdd && (
                            <div className="border-border/60 text-muted-foreground flex flex-col items-center gap-1 rounded-lg border border-dashed p-6 text-center text-sm">
                                <Package className="mb-1 h-6 w-6 opacity-60" />
                                No product-level stock yet.
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="mt-2"
                                    disabled={availableLocations.length === 0 && locationsQuery.isLoading}
                                    onClick={() => setShowAdd(true)}
                                >
                                    <Plus className="mr-1.5 h-4 w-4" />
                                    Add Stock Location
                                </Button>
                            </div>
                        )}

                        {showAdd && (
                            <div className="border-primary/40 bg-primary/5 space-y-3 rounded-lg border p-3">
                                <div className="flex items-center justify-between">
                                    <span className="flex items-center gap-2 text-sm font-medium">
                                        <Plus className="text-primary h-4 w-4" />
                                        New Stock Location
                                    </span>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7"
                                        onClick={() => setShowAdd(false)}
                                    >
                                        <X className="h-4 w-4" />
                                    </Button>
                                </div>
                                <div className="grid gap-3 sm:grid-cols-2">
                                    <div className="space-y-1">
                                        <Label className="text-xs">Location</Label>
                                        <Select value={addLocationId} onValueChange={setAddLocationId}>
                                            <SelectTrigger className="h-8 w-full">
                                                {addLocationId ? (
                                                    <span>{locationName(addLocationId)}</span>
                                                ) : (
                                                    <SelectValue
                                                        placeholder={
                                                            locationsQuery.isLoading
                                                                ? 'Loading…'
                                                                : availableLocations.length === 0
                                                                  ? 'No locations available'
                                                                  : 'Select a location…'
                                                        }
                                                    />
                                                )}
                                            </SelectTrigger>
                                            <SelectContent>
                                                {availableLocations.map(loc => (
                                                    <SelectItem key={loc.id} value={String(loc.id)}>
                                                        {loc.name}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-xs">Initial Stock ({unitLabel})</Label>
                                        <Input
                                            type="number"
                                            min="0"
                                            step={inputStep}
                                            className="h-8"
                                            value={addStock}
                                            onChange={e => setAddStock(e.target.value)}
                                        />
                                    </div>
                                </div>
                                <div className="flex justify-end gap-2">
                                    <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>
                                        Cancel
                                    </Button>
                                    <Button
                                        size="sm"
                                        disabled={saving || !addLocationId}
                                        onClick={() =>
                                            setStockMutation.mutate({
                                                stockLocationId: addLocationId,
                                                amount: Number(addStock),
                                            })
                                        }
                                    >
                                        <Check className="mr-1.5 h-4 w-4" />
                                        Save
                                    </Button>
                                </div>
                            </div>
                        )}

                        {levels.length > 0 && !showAdd && availableLocations.length > 0 && (
                            <div className="border-border/60 flex border-t pt-3">
                                <Button variant="outline" size="sm" onClick={() => setShowAdd(true)}>
                                    <Plus className="mr-1.5 h-4 w-4" />
                                    Add Location
                                </Button>
                            </div>
                        )}
                    </>
                )}
            </section>

            {/* ── Stock Overview ─────────────────────────── */}
            {overview && (
                <section className="space-y-4 pt-5">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Package className="text-muted-foreground h-4 w-4" />
                            <h3 className="text-sm font-semibold">Stock Overview</h3>
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={saving}
                            onClick={() => resyncMutation.mutate()}
                        >
                            <RefreshCw className={`mr-1.5 h-4 w-4 ${resyncMutation.isPending ? 'animate-spin' : ''}`} />
                            Re-sync
                        </Button>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                        <StatTile label="Total Stock" value={`${toDisplay(overview.stockOnHand)} ${unitLabel}`} />
                        <StatTile label="Allocated" value={`${toDisplay(overview.stockAllocated)} ${unitLabel}`} />
                        <StatTile
                            label="Available"
                            value={`${toDisplay(overview.availableWeight)} ${unitLabel}`}
                            accent
                        />
                    </div>

                    {/* A variant missing from the table below is not lost stock: it is
                        authored in a unit this pool cannot add up, or carries no
                        measurement at all. Saying so beats leaving a blank row. */}
                    {overview.excludedVariants.length > 0 && (
                        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                            <div className="flex items-start gap-2">
                                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                                <div className="space-y-1.5">
                                    <div className="text-sm font-medium">
                                        {overview.excludedVariants.length}{' '}
                                        {overview.excludedVariants.length === 1
                                            ? 'variant is'
                                            : 'variants are'}{' '}
                                        not drawing from this pool
                                    </div>
                                    <p className="text-muted-foreground text-xs">
                                        This pool counts <strong>{unitLabel}</strong>. A variant measured in
                                        another unit cannot be added to it, and one with no measurement has
                                        nothing to divide by &mdash; either way it is left out and shows no
                                        pool stock. Set Measure Value and Measure Unit on the option
                                        (Catalog &rsaquo; Option Groups).
                                    </p>
                                    <ul className="space-y-1 text-xs">
                                        {overview.excludedVariants.map(v => (
                                            <li
                                                key={String(v.variantId)}
                                                className="flex flex-wrap items-center gap-1.5"
                                            >
                                                <span className="font-medium">{v.name}</span>
                                                <Badge variant="outline">
                                                    {v.reason === 'NO_MEASUREMENT'
                                                        ? 'no measurement'
                                                        : `${v.measure} \u00b7 from its option`}
                                                </Badge>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            </div>
                        </div>
                    )}

                    {overview.variants.length > 0 && (
                        <div className="overflow-hidden rounded-lg border">
                            <Table>
                                <TableHeader>
                                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                                        <TableHead>Variant</TableHead>
                                        <TableHead className="text-right">Per unit</TableHead>
                                        <TableHead className="text-right">Available</TableHead>
                                        <TableHead className="text-right">Allocated</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {overview.variants.map(v => {
                                        const variant =
                                            v.availableStock === 0
                                                ? 'destructive'
                                                : v.availableStock <= 10
                                                  ? 'warning'
                                                  : 'success';
                                        return (
                                            <TableRow key={v.variantId}>
                                                <TableCell className="font-medium">{v.name}</TableCell>
                                                <TableCell className="text-right">
                                                    <Badge variant="outline" className="tabular-nums">
                                                        {toDisplay(v.weight)} {unitLabel}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    <Badge variant={variant} className="tabular-nums">
                                                        {v.availableStock}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell className="text-right tabular-nums">
                                                    {v.stockAllocated}
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </section>
            )}
            </>
            )}
        </div>
    );
}

function StatTile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
    return (
        <div
            className={`rounded-lg border p-3 ${accent ? 'border-primary/30 bg-primary/5' : 'bg-muted/40'}`}
        >
            <div className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
                {label}
            </div>
            <div className={`mt-1 text-lg font-bold tabular-nums ${accent ? 'text-primary' : ''}`}>
                {value}
            </div>
        </div>
    );
}

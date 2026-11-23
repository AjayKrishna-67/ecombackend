import {
    api,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Field,
    FieldLabel,
    FormFieldWrapper,
    Input,
    NumberInput,
    PageContextValue,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
} from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import {
    deleteStockLevelDocument,
    StockLocationOption,
    stockLocationsDocument,
} from './queries';

interface FormStockLevel {
    stockLocationId: string;
    stockOnHand: number;
}

export function StockLocationsBlock({ context }: { context: PageContextValue }) {
    const form = context.form;
    const entity = context.entity;
    const variantId = entity?.id ? String(entity.id) : undefined;
    const queryClient = useQueryClient();
    const [pending, setPending] = useState<{ id: string; name: string; saved: boolean } | null>(null);

    const locationsQuery = useQuery({
        queryKey: ['stock-locations'],
        queryFn: () => api.query(stockLocationsDocument, {}),
    });

    const deleteMutation = useMutation({
        mutationFn: (stockLocationId: string) =>
            api.mutate(deleteStockLevelDocument, { productVariantId: variantId!, stockLocationId }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['variant-stock-levels', variantId] });
        },
    });

    if (!form || !variantId) return null;

    const locations: StockLocationOption[] = (locationsQuery.data as any)?.stockLocations?.items ?? [];
    const stockLevels: FormStockLevel[] = form.watch('stockLevels') ?? [];
    const usedIds = new Set(stockLevels.map(sl => String(sl.stockLocationId)));
    const availableLocations = locations.filter(loc => !usedIds.has(String(loc.id)));

    const locationName = (id: string) =>
        locations.find(l => String(l.id) === String(id))?.name ?? `Location #${id}`;
    const allocatedFor = (id: string) =>
        (entity?.stockLevels ?? []).find((sl: any) => String(sl.stockLocation?.id) === String(id))
            ?.stockAllocated ?? 0;
    const isSaved = (id: string) =>
        (entity?.stockLevels ?? []).some((sl: any) => String(sl.stockLocation?.id) === String(id));

    function addLocation(stockLocationId: string) {
        const current: FormStockLevel[] = form!.getValues('stockLevels') ?? [];
        form!.setValue('stockLevels', [...current, { stockLocationId, stockOnHand: 0 }], {
            shouldDirty: true,
        });
    }

    function removeFromForm(stockLocationId: string) {
        const current: FormStockLevel[] = form!.getValues('stockLevels') ?? [];
        form!.setValue(
            'stockLevels',
            current.filter(sl => String(sl.stockLocationId) !== String(stockLocationId)),
            { shouldDirty: true },
        );
    }

    async function confirmDelete() {
        if (!pending) return;
        if (pending.saved) {
            await deleteMutation.mutateAsync(pending.id);
        }
        removeFromForm(pending.id);
        setPending(null);
    }

    return (
        <div className="space-y-6">
            {/* ── Tracking + threshold controls ──────────── */}
            <div className="grid gap-4 sm:grid-cols-2">
                <FormFieldWrapper
                    control={form.control}
                    name="trackInventory"
                    label="Stock levels"
                    renderFormControl={false}
                    render={({ field }: any) => (
                        <Select value={field.value} onValueChange={val => val && field.onChange(val)}>
                            <SelectTrigger className="w-full">
                                <SelectValue placeholder="Track inventory" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="INHERIT">Inherit from global settings</SelectItem>
                                <SelectItem value="TRUE">Track</SelectItem>
                                <SelectItem value="FALSE">Do not track</SelectItem>
                            </SelectContent>
                        </Select>
                    )}
                />
                <FormFieldWrapper
                    control={form.control}
                    name="outOfStockThreshold"
                    label="Out-of-stock threshold"
                    description="Sets the stock level at which this variant is considered to be out of stock. Using a negative value enables backorder support."
                    render={({ field }: any) => (
                        <Input
                            type="number"
                            value={field.value}
                            onChange={e => field.onChange(e.target.valueAsNumber)}
                        />
                    )}
                />
                <FormFieldWrapper
                    control={form.control}
                    name="useGlobalOutOfStockThreshold"
                    label="Use global out-of-stock threshold"
                    description="When enabled, the global out-of-stock threshold is used instead of the variant-specific value."
                    render={({ field }: any) => (
                        <Switch checked={field.value} onCheckedChange={field.onChange} />
                    )}
                />
            </div>

            {/* ── Per-location stock + delete ────────────── */}
            <div className="space-y-2">
                {stockLevels.map((stockLevel, index) => (
                    <div
                        key={stockLevel.stockLocationId}
                        className="grid items-end gap-4 sm:grid-cols-2"
                    >
                        <FormFieldWrapper
                            control={form.control}
                            name={`stockLevels.${index}.stockOnHand`}
                            label={
                                <span className="flex items-center gap-2">
                                    Stock level
                                    {stockLevels.length > 1 && (
                                        <span className="text-muted-foreground font-normal">
                                            {locationName(stockLevel.stockLocationId)}
                                        </span>
                                    )}
                                </span>
                            }
                            render={({ field }: any) => <NumberInput {...field} value={field.value} />}
                        />
                        <div className="flex items-end justify-between gap-4">
                            <Field>
                                <FieldLabel>Allocated</FieldLabel>
                                <div className="pt-1.5 text-sm tabular-nums">
                                    {allocatedFor(stockLevel.stockLocationId)}
                                </div>
                            </Field>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={deleteMutation.isPending}
                                onClick={() =>
                                    setPending({
                                        id: stockLevel.stockLocationId,
                                        name: locationName(stockLevel.stockLocationId),
                                        saved: isSaved(stockLevel.stockLocationId),
                                    })
                                }
                            >
                                <Trash2 className="text-destructive mr-1.5 h-4 w-4" />
                                Delete
                            </Button>
                        </div>
                    </div>
                ))}

                {stockLevels.length === 0 && (
                    <div className="text-muted-foreground rounded-md border border-dashed p-4 text-center text-sm">
                        No stock locations configured for this variant.
                    </div>
                )}
            </div>

            {/* ── Add location ───────────────────────────── */}
            {availableLocations.length > 0 && (
                <Select value="" onValueChange={id => id && addLocation(id)}>
                    <SelectTrigger className="w-auto">
                        <Plus className="mr-1.5 h-4 w-4" />
                        <SelectValue placeholder="Add stock location" />
                    </SelectTrigger>
                    <SelectContent>
                        {availableLocations.map(loc => (
                            <SelectItem key={loc.id} value={String(loc.id)}>
                                {loc.name}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}

            {/* ── Delete confirm ─────────────────────────── */}
            <Dialog open={!!pending} onOpenChange={open => !open && setPending(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Remove stock location</DialogTitle>
                        <DialogDescription>
                            Remove stock at <strong>{pending?.name}</strong> for this variant?
                            {pending?.saved
                                ? ' This deletes the stock level record immediately.'
                                : ' This removes the unsaved location row.'}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setPending(null)}
                            disabled={deleteMutation.isPending}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={confirmDelete}
                            disabled={deleteMutation.isPending}
                        >
                            {deleteMutation.isPending ? 'Removing…' : 'Remove'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

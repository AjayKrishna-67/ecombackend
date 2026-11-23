import {
    api,
    AssetPickerDialog,
    Badge,
    Button,
    Card,
    CardContent,
    Page,
    PageTitle,
    Spinner,
    toast,
} from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, ImageOff, Store } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import {
    BrandSeller,
    BrandStorefront,
    DEFAULT_CHANNEL_CODE,
    DEFAULT_SELLER_NAME,
    getActiveAdminChannelDocument,
    getBrandSellersDocument,
    getBrandStorefrontsDocument,
    LaunchStatus,
    setBrandStorefrontOrderDocument,
    StorefrontAsset,
    upsertBrandStorefrontDocument,
} from './queries';

const SELLERS_KEY = ['brand-sellers'];
const STOREFRONTS_KEY = ['brand-storefronts'];
const ACTIVE_CHANNEL_KEY = ['active-admin-channel'];

interface RowState {
    sellerId: string;
    name: string;
    bannerAsset: StorefrontAsset | null;
    launchStatus: LaunchStatus;
    showInStoreSwitcher: boolean;
    sortOrder: number | null;
}

// Nulls sort last, then by sortOrder ascending.
function bySortOrder(a: RowState, b: RowState): number {
    const av = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const bv = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
    return av - bv;
}

export function BrandStorefrontListPage() {
    const queryClient = useQueryClient();
    const [rows, setRows] = useState<RowState[]>([]);
    const [pickerSellerId, setPickerSellerId] = useState<string | null>(null);
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

    const { data: sellersData, isLoading: sellersLoading } = useQuery({
        queryKey: SELLERS_KEY,
        queryFn: () => api.query(getBrandSellersDocument, {}),
    });
    const { data: storefrontsData, isLoading: storefrontsLoading } = useQuery({
        queryKey: STOREFRONTS_KEY,
        queryFn: () => api.query(getBrandStorefrontsDocument, {}),
    });
    const { data: activeChannelData, isLoading: activeChannelLoading } = useQuery({
        queryKey: ACTIVE_CHANNEL_KEY,
        queryFn: () => api.query(getActiveAdminChannelDocument, {}),
    });

    useEffect(() => {
        const sellers: BrandSeller[] = (sellersData as any)?.sellers?.items ?? [];
        const storefronts: BrandStorefront[] = (storefrontsData as any)?.brandStorefronts ?? [];
        if (!sellers.length && !storefronts.length) return;
        // Channel scope: on the default (super-admin) channel show every brand;
        // on a brand's channel show only that brand's seller.
        const activeChannel = (activeChannelData as any)?.activeChannel;
        const scopedSellerId =
            activeChannel && activeChannel.code !== DEFAULT_CHANNEL_CODE && activeChannel.seller
                ? String(activeChannel.seller.id)
                : null;
        const bySeller = new Map(storefronts.map(s => [String(s.seller.id), s]));
        let brandSellers = sellers.filter(s => s.name !== DEFAULT_SELLER_NAME);
        if (scopedSellerId) {
            brandSellers = brandSellers.filter(s => String(s.id) === scopedSellerId);
        }
        setRows(
            brandSellers
                .map(seller => {
                    const sf = bySeller.get(String(seller.id));
                    return {
                        sellerId: String(seller.id),
                        name: seller.name,
                        bannerAsset: sf?.bannerImage ?? null,
                        launchStatus: sf?.launchStatus ?? 'OPENING_SOON',
                        showInStoreSwitcher: sf?.showInStoreSwitcher ?? false,
                        sortOrder: sf?.sortOrder ?? null,
                    } as RowState;
                })
                .sort(bySortOrder),
        );
    }, [sellersData, storefrontsData, activeChannelData]);

    const patchRow = (sellerId: string, patch: Partial<RowState>) =>
        setRows(prev => prev.map(r => (r.sellerId === sellerId ? { ...r, ...patch } : r)));

    const saveMutation = useMutation({
        mutationFn: (row: RowState) =>
            api.mutate(upsertBrandStorefrontDocument, {
                input: {
                    sellerId: row.sellerId,
                    bannerImageId: row.bannerAsset ? row.bannerAsset.id : null,
                    launchStatus: row.launchStatus,
                    showInStoreSwitcher: row.showInStoreSwitcher,
                    sortOrder: row.sortOrder,
                },
            }),
        onSuccess: () => {
            toast.success('Storefront saved');
            queryClient.invalidateQueries({ queryKey: STOREFRONTS_KEY });
        },
        onError: (e: any) => toast.error(`Save failed: ${e.message}`),
    });

    const reorderMutation = useMutation({
        mutationFn: (sellerIds: string[]) =>
            api.mutate(setBrandStorefrontOrderDocument, { sellerIds }),
        onSuccess: () => {
            toast.success('Order saved');
            queryClient.invalidateQueries({ queryKey: STOREFRONTS_KEY });
        },
        onError: (e: any) => toast.error(`Reorder failed: ${e.message}`),
    });

    const handleDragEnd = (event: any) => {
        const { active, over } = event;
        if (!over || active.id === over.id) return;
        const oldIndex = rows.findIndex(r => r.sellerId === active.id);
        const newIndex = rows.findIndex(r => r.sellerId === over.id);
        if (oldIndex < 0 || newIndex < 0) return;
        // Keep the state updater pure — side effects (the mutation) run OUTSIDE
        // it, else React StrictMode double-invokes the updater and fires twice.
        const next = arrayMove(rows, oldIndex, newIndex).map((r, i) => ({ ...r, sortOrder: i }));
        setRows(next);
        reorderMutation.mutate(next.map(r => r.sellerId));
    };

    const handlePicked = (assets: Array<StorefrontAsset>) => {
        const asset = assets[0];
        if (asset && pickerSellerId) patchRow(pickerSellerId, { bannerAsset: asset });
        setPickerSellerId(null);
    };

    const isLoading = sellersLoading || storefrontsLoading || activeChannelLoading;

    return (
        <Page pageId="brand-storefront-list">
            <PageTitle>Brand Storefronts</PageTitle>
            <div className="space-y-4 px-4 pb-6">
                <p className="text-muted-foreground text-sm">
                    Control which brands (sellers) appear in the app "Switch Store" sheet, their launch
                    state, and banner. Drag the handle to reorder how brands stack in the app. A brand
                    only shows when "Show in switcher" is on.
                </p>

                {isLoading ? (
                    <div className="flex justify-center p-6">
                        <Spinner />
                    </div>
                ) : rows.length === 0 ? (
                    <Card>
                        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                            <div className="bg-muted text-muted-foreground flex h-20 w-20 items-center justify-center rounded-full">
                                <Store className="h-10 w-10" />
                            </div>
                            <h3 className="text-xl font-semibold">No brand sellers</h3>
                            <p className="text-muted-foreground text-sm">
                                Create a Seller (one per brand) under Settings → Sellers, then it appears
                                here. The seeded "Default Seller" is not a brand.
                            </p>
                        </CardContent>
                    </Card>
                ) : (
                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                        <SortableContext items={rows.map(r => r.sellerId)} strategy={rectSortingStrategy}>
                            <div className="grid gap-4 lg:grid-cols-2">
                                {rows.map(row => (
                                    <SortableBrandCard
                                        key={row.sellerId}
                                        row={row}
                                        onPatch={patchRow}
                                        onPick={() => setPickerSellerId(row.sellerId)}
                                        onSave={() => saveMutation.mutate(row)}
                                        saving={saveMutation.isPending}
                                    />
                                ))}
                            </div>
                        </SortableContext>
                    </DndContext>
                )}
            </div>

            {pickerSellerId && (
                <AssetPickerDialog
                    open={!!pickerSellerId}
                    multiSelect={false}
                    title="Select banner image"
                    onClose={() => setPickerSellerId(null)}
                    onSelect={handlePicked as any}
                />
            )}
        </Page>
    );
}

function SortableBrandCard({
    row,
    onPatch,
    onPick,
    onSave,
    saving,
}: {
    row: RowState;
    onPatch: (sellerId: string, patch: Partial<RowState>) => void;
    onPick: () => void;
    onSave: () => void;
    saving: boolean;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: row.sellerId,
    });
    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
    };
    return (
        <div ref={setNodeRef} style={style}>
            <Card className="overflow-hidden">
                <CardContent className="space-y-4 py-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                className="text-muted-foreground cursor-grab touch-none active:cursor-grabbing"
                                title="Drag to reorder"
                                {...attributes}
                                {...listeners}
                            >
                                <GripVertical className="h-5 w-5" />
                            </button>
                            <Store className="text-primary h-5 w-5" />
                            <span className="font-semibold">{row.name}</span>
                        </div>
                        <Badge variant={row.launchStatus === 'LAUNCHED' ? 'default' : 'secondary'}>
                            {row.launchStatus === 'LAUNCHED' ? 'Launched' : 'Opening soon'}
                        </Badge>
                    </div>

                    <div className="bg-muted flex h-40 items-center justify-center overflow-hidden rounded-lg">
                        {row.bannerAsset ? (
                            <img
                                src={`${row.bannerAsset.preview}?preset=medium`}
                                alt={row.bannerAsset.name}
                                className="h-full w-full object-cover"
                            />
                        ) : (
                            <div className="text-muted-foreground flex flex-col items-center gap-1 text-sm">
                                <ImageOff className="h-8 w-8" />
                                No banner
                            </div>
                        )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" size="sm" onClick={onPick}>
                            {row.bannerAsset ? 'Change banner' : 'Pick banner'}
                        </Button>
                        {row.bannerAsset && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => onPatch(row.sellerId, { bannerAsset: null })}
                            >
                                Remove
                            </Button>
                        )}
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="text-muted-foreground">Launch status</span>
                        <select
                            value={row.launchStatus}
                            onChange={e => onPatch(row.sellerId, { launchStatus: e.target.value as LaunchStatus })}
                            className="bg-background w-full rounded border px-2 py-1.5"
                        >
                            <option value="OPENING_SOON">Opening soon (locked)</option>
                            <option value="LAUNCHED">Launched (open)</option>
                        </select>
                    </label>

                    <label className="flex items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            checked={row.showInStoreSwitcher}
                            onChange={e => onPatch(row.sellerId, { showInStoreSwitcher: e.target.checked })}
                        />
                        <span>Show in app switcher</span>
                    </label>

                    <div className="flex justify-end border-t pt-3">
                        <Button size="sm" disabled={saving} onClick={onSave}>
                            Save
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}

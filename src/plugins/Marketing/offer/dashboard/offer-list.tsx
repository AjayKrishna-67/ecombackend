import {
    api,
    AssetPickerDialog,
    Badge,
    Button,
    Card,
    CardContent,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input,
    Page,
    PageTitle,
    Spinner,
    toast,
} from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, Eye, EyeOff, ImageIcon, Pencil, Plus, Trash2, X } from 'lucide-react';
import React, { useState } from 'react';
import {
    createOfferDocument,
    deleteOfferDocument,
    getOffersDocument,
    Offer,
    OfferAsset,
    searchCollectionsDocument,
    searchProductsDocument,
    searchVariantsDocument,
    TargetKind,
    TargetOption,
    updateOfferDocument,
} from './queries';

const QUERY_KEY = ['custom-offers'];

const TARGET_TABS: Array<{ kind: TargetKind; label: string }> = [
    { kind: 'product', label: 'Product' },
    { kind: 'collection', label: 'Category' },
    { kind: 'variant', label: 'SKU' },
];

export function OfferListPage() {
    const queryClient = useQueryClient();
    const invalidate = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [selectedAsset, setSelectedAsset] = useState<OfferAsset | null>(null);
    const [targetKind, setTargetKind] = useState<TargetKind>('product');
    const [targetTerm, setTargetTerm] = useState('');
    const [targetOptions, setTargetOptions] = useState<TargetOption[]>([]);
    const [selectedTarget, setSelectedTarget] = useState<TargetOption | null>(null);
    const [isPreviewMode, setIsPreviewMode] = useState(false);
    const [previewOffer, setPreviewOffer] = useState<Offer | null>(null);

    const { data, isLoading } = useQuery({
        queryKey: QUERY_KEY,
        queryFn: () => api.query(getOffersDocument),
    });
    const offers: Offer[] = (data as any)?.allBannerPopup?.items ?? [];

    const resetForm = () => {
        setSelectedAsset(null);
        setTargetKind('product');
        setTargetTerm('');
        setTargetOptions([]);
        setSelectedTarget(null);
        setIsPreviewMode(false);
        setEditingId(null);
    };

    const createMutation = useMutation({
        mutationFn: (input: any) => api.mutate(createOfferDocument, { input }),
        onSuccess: () => {
            toast.success('Offer created');
            closeForm();
            invalidate();
        },
        onError: (e: any) => toast.error(`Create failed: ${e.message}`),
    });
    const updateMutation = useMutation({
        mutationFn: (input: any) => api.mutate(updateOfferDocument, { input }),
        onSuccess: () => {
            toast.success('Offer updated');
            invalidate();
        },
        onError: (e: any) => toast.error(`Update failed: ${e.message}`),
    });
    const deleteMutation = useMutation({
        mutationFn: (id: string) => api.mutate(deleteOfferDocument, { id }),
        onSuccess: () => {
            toast.success('Offer deleted');
            invalidate();
        },
        onError: (e: any) => toast.error(`Delete failed: ${e.message}`),
    });

    const closeForm = () => {
        resetForm();
        setShowForm(false);
    };
    const toggleForm = () => {
        if (showForm) {
            closeForm();
        } else {
            resetForm();
            setShowForm(true);
        }
    };

    const handleSearch = async (term: string) => {
        setTargetTerm(term);
        if (!term.trim()) {
            setTargetOptions([]);
            return;
        }
        if (targetKind === 'product') {
            const res: any = await api.query(searchProductsDocument, { term });
            setTargetOptions((res?.products?.items ?? []).map((p: any) => ({ id: p.id, label: p.name })));
        } else if (targetKind === 'collection') {
            const res: any = await api.query(searchCollectionsDocument, { term });
            setTargetOptions((res?.collections?.items ?? []).map((c: any) => ({ id: c.id, label: c.name })));
        } else {
            const res: any = await api.query(searchVariantsDocument, { term });
            setTargetOptions(
                (res?.productVariants?.items ?? []).map((v: any) => ({ id: v.id, label: `${v.sku} — ${v.name}` })),
            );
        }
    };

    const changeTargetKind = (kind: TargetKind) => {
        setTargetKind(kind);
        setTargetTerm('');
        setTargetOptions([]);
        setSelectedTarget(null);
    };

    const handleSubmit = () => {
        if (!selectedAsset) {
            return;
        }
        const targetFields: any = editingId
            ? { productId: null, collectionId: null, productVariantId: null }
            : {};
        if (selectedTarget) {
            if (targetKind === 'product') targetFields.productId = selectedTarget.id;
            if (targetKind === 'collection') targetFields.collectionId = selectedTarget.id;
            if (targetKind === 'variant') targetFields.productVariantId = selectedTarget.id;
        }
        const base = { assetId: selectedAsset.id, isPreview: isPreviewMode, ...targetFields };
        if (editingId) {
            updateMutation.mutate({ id: editingId, ...base }, { onSuccess: () => closeForm() });
        } else {
            createMutation.mutate(base);
        }
    };

    const editOffer = (offer: Offer) => {
        setEditingId(offer.id);
        setShowForm(true);
        setSelectedAsset(offer.asset);
        setIsPreviewMode(offer.isPreview);
        if (offer.product) {
            setTargetKind('product');
            setSelectedTarget({ id: offer.product.id, label: offer.product.name });
        } else if (offer.collection) {
            setTargetKind('collection');
            setSelectedTarget({ id: offer.collection.id, label: offer.collection.name });
        } else if (offer.productVariant) {
            setTargetKind('variant');
            setSelectedTarget({
                id: offer.productVariant.id,
                label: `${offer.productVariant.sku} — ${offer.productVariant.name}`,
            });
        } else {
            setTargetKind('product');
            setSelectedTarget(null);
        }
        setTargetTerm('');
        setTargetOptions([]);
    };

    const togglePreviewStatus = (offer: Offer) => {
        updateMutation.mutate({ id: offer.id, isPreview: !offer.isPreview });
    };

    const handlePicked = (assets: Array<OfferAsset>) => {
        if (assets[0]) {
            setSelectedAsset(assets[0]);
        }
        setPickerOpen(false);
    };

    const targetSearchPlaceholder =
        targetKind === 'product'
            ? 'Search product by name'
            : targetKind === 'collection'
              ? 'Search category by name'
              : 'Search variant by name';

    return (
        <Page pageId="offer-list">
            <PageTitle>Offer Management</PageTitle>
            <div className="px-4 pb-6">
                {/* Tabs */}
                <div className="mb-6 flex gap-1 border-b">
                    <Link
                        to="/banners"
                        className="text-muted-foreground hover:text-primary -mb-px border-b-2 border-transparent px-6 py-2.5 text-sm font-medium"
                    >
                        Banners
                    </Link>
                    <span className="border-primary text-primary -mb-px border-b-2 px-6 py-2.5 text-sm font-semibold">
                        Offers
                    </span>
                </div>

                {/* Action bar */}
                <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-base font-medium">
                        {offers.length} offer{offers.length === 1 ? '' : 's'}
                    </h3>
                    <Button onClick={toggleForm}>
                        {showForm ? <X className="mr-1 h-4 w-4" /> : <Plus className="mr-1 h-4 w-4" />}
                        {showForm ? 'Cancel' : 'New offer'}
                    </Button>
                </div>

                {/* Create / edit form */}
                {showForm && (
                    <Card className="mb-6">
                        <CardContent className="space-y-4 py-4">
                            <div className="text-sm font-semibold">
                                {editingId ? 'Edit offer' : 'Create new offer'}
                            </div>
                            <div className="flex flex-wrap gap-6">
                                {/* Image */}
                                <div className="flex flex-col gap-2">
                                    <label className="text-sm font-medium">
                                        Image <span className="text-destructive">*</span>
                                    </label>
                                    <button
                                        type="button"
                                        onClick={() => setPickerOpen(true)}
                                        className="bg-muted hover:border-primary flex h-32 w-48 items-center justify-center overflow-hidden rounded border"
                                    >
                                        {selectedAsset ? (
                                            <img
                                                src={`${selectedAsset.preview}?preset=thumb`}
                                                alt={selectedAsset.name}
                                                className="h-full w-full object-cover"
                                            />
                                        ) : (
                                            <span className="text-muted-foreground flex flex-col items-center gap-1 text-sm">
                                                <ImageIcon className="h-8 w-8" />
                                                Pick from assets
                                            </span>
                                        )}
                                    </button>
                                    <small className="text-muted-foreground text-xs">One image per offer</small>
                                </div>

                                {/* Target */}
                                <div className="min-w-[260px] flex-1">
                                    <label className="text-sm font-medium">
                                        Link to <span className="text-muted-foreground">(optional)</span>
                                    </label>
                                    <div className="mt-2 flex gap-1">
                                        {TARGET_TABS.map(tab => (
                                            <button
                                                key={tab.kind}
                                                type="button"
                                                onClick={() => changeTargetKind(tab.kind)}
                                                className={
                                                    'rounded border px-3 py-1 text-sm ' +
                                                    (targetKind === tab.kind
                                                        ? 'bg-primary text-primary-foreground border-primary'
                                                        : 'bg-background text-muted-foreground')
                                                }
                                            >
                                                {tab.label}
                                            </button>
                                        ))}
                                    </div>
                                    <div className="relative mt-2">
                                        <Input
                                            value={targetTerm}
                                            placeholder={targetSearchPlaceholder}
                                            onChange={e => handleSearch(e.target.value)}
                                        />
                                        {targetOptions.length > 0 && (
                                            <ul className="bg-popover absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded border shadow">
                                                {targetOptions.map(opt => (
                                                    <li
                                                        key={opt.id}
                                                        onClick={() => {
                                                            setSelectedTarget(opt);
                                                            setTargetOptions([]);
                                                            setTargetTerm('');
                                                        }}
                                                        className="hover:bg-accent cursor-pointer px-3 py-2 text-sm"
                                                    >
                                                        {opt.label}
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                    {selectedTarget && (
                                        <div className="bg-accent mt-2 inline-flex items-center gap-2 rounded px-2 py-1 text-sm">
                                            <Check className="h-3 w-3" />
                                            {selectedTarget.label}
                                            <button
                                                type="button"
                                                onClick={() => setSelectedTarget(null)}
                                                className="text-muted-foreground hover:text-foreground"
                                            >
                                                <X className="h-3 w-3" />
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    checked={isPreviewMode}
                                    onChange={e => setIsPreviewMode(e.target.checked)}
                                />
                                Set as Preview
                            </label>

                            <div className="flex justify-end gap-2">
                                <Button variant="outline" onClick={closeForm}>
                                    Cancel
                                </Button>
                                <Button
                                    disabled={!selectedAsset || createMutation.isPending || updateMutation.isPending}
                                    onClick={handleSubmit}
                                >
                                    {editingId ? 'Save changes' : 'Create offer'}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                )}

                {/* Grid */}
                {isLoading ? (
                    <div className="flex justify-center p-6">
                        <Spinner />
                    </div>
                ) : offers.length === 0 ? (
                    <div className="text-muted-foreground flex justify-center p-10 text-sm">
                        No offers yet. Create one to get started.
                    </div>
                ) : (
                    <div className="grid grid-cols-4 gap-4">
                        {offers.map(offer => (
                            <Card key={offer.id} className="overflow-hidden">
                                <button
                                    type="button"
                                    onClick={() => setPreviewOffer(offer)}
                                    className="bg-muted relative flex h-44 w-full items-center justify-center overflow-hidden"
                                >
                                    <img
                                        src={`${offer.asset.preview}?preset=medium`}
                                        alt={offer.asset.name}
                                        className="h-full w-full object-cover"
                                    />
                                    {offer.isPreview ? (
                                        <Badge className="absolute left-2 top-2" variant="default">
                                            Live
                                        </Badge>
                                    ) : (
                                        <Badge className="absolute left-2 top-2" variant="secondary">
                                            Draft
                                        </Badge>
                                    )}
                                </button>
                                <CardContent className="space-y-2 py-3">
                                    <div className="flex items-center gap-2">
                                        {offer.product && <Badge variant="outline">Product</Badge>}
                                        {offer.collection && <Badge variant="outline">Category</Badge>}
                                        {offer.productVariant && <Badge variant="outline">SKU</Badge>}
                                        {!offer.product && !offer.collection && !offer.productVariant && (
                                            <Badge variant="secondary">No link</Badge>
                                        )}
                                    </div>
                                    <div className="truncate text-sm">
                                        {offer.product?.name ||
                                            offer.collection?.name ||
                                            offer.productVariant?.sku ||
                                            'Image only'}
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                        <Button size="sm" variant="outline" onClick={() => togglePreviewStatus(offer)}>
                                            {offer.isPreview ? (
                                                <EyeOff className="mr-1 h-4 w-4" />
                                            ) : (
                                                <Eye className="mr-1 h-4 w-4" />
                                            )}
                                            {offer.isPreview ? 'Set Draft' : 'Set Live'}
                                        </Button>
                                        <Button size="sm" variant="secondary" onClick={() => editOffer(offer)}>
                                            <Pencil className="h-4 w-4" />
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="destructive"
                                            onClick={() => deleteMutation.mutate(offer.id)}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}
            </div>

            {/* Asset picker */}
            {pickerOpen && (
                <AssetPickerDialog
                    open={pickerOpen}
                    multiSelect={false}
                    title="Select offer image"
                    onClose={() => setPickerOpen(false)}
                    onSelect={handlePicked as any}
                />
            )}

            {/* Preview modal */}
            <Dialog open={!!previewOffer} onOpenChange={open => !open && setPreviewOffer(null)}>
                <DialogContent className="sm:max-w-[700px]">
                    <DialogHeader>
                        <DialogTitle>Offer preview</DialogTitle>
                    </DialogHeader>
                    {previewOffer && (
                        <div className="space-y-4">
                            <img
                                src={`${previewOffer.asset.preview}?preset=large`}
                                alt={previewOffer.asset.name}
                                className="max-h-[60vh] w-full rounded object-contain"
                            />
                            <div className="flex items-center justify-between">
                                <div className="text-sm">
                                    {previewOffer.product
                                        ? `Product: ${previewOffer.product.name}`
                                        : previewOffer.collection
                                          ? `Category: ${previewOffer.collection.name}`
                                          : previewOffer.productVariant
                                            ? `SKU: ${previewOffer.productVariant.sku}`
                                            : 'Image only'}
                                </div>
                                <Button
                                    variant="outline"
                                    onClick={() => {
                                        togglePreviewStatus(previewOffer);
                                        setPreviewOffer({ ...previewOffer, isPreview: !previewOffer.isPreview });
                                    }}
                                >
                                    {previewOffer.isPreview ? 'Remove from Live' : 'Set as Live'}
                                </Button>
                            </div>
                        </div>
                    )}
                </DialogContent>
            </Dialog>
        </Page>
    );
}

import {
    api,
    AssetPickerDialog,
    Button,
    Card,
    CardContent,
    Page,
    PageTitle,
    Spinner,
    toast,
} from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Pencil, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import {
    Banner,
    BannerAsset,
    createBannerDocument,
    deleteBannerDocument,
    getBannersDocument,
    updateBannerDocument,
} from './queries';

const QUERY_KEY = ['custom-banners'];

export function BannerListPage() {
    const queryClient = useQueryClient();
    const [selectedAsset, setSelectedAsset] = useState<BannerAsset | null>(null);
    const [pickerMode, setPickerMode] = useState<'create' | 'update' | null>(null);
    const [updateTargetId, setUpdateTargetId] = useState<string | null>(null);

    const { data, isLoading } = useQuery({
        queryKey: QUERY_KEY,
        queryFn: () => api.query(getBannersDocument, {}),
    });

    const invalidate = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

    const createMutation = useMutation({
        mutationFn: (assetId: string) => api.mutate(createBannerDocument, { input: { assetIds: [assetId] } }),
        onSuccess: () => {
            toast.success('Banner created');
            setSelectedAsset(null);
            invalidate();
        },
        onError: (e: any) => toast.error(`Create failed: ${e.message}`),
    });

    const updateMutation = useMutation({
        mutationFn: ({ id, assetId }: { id: string; assetId: string }) =>
            api.mutate(updateBannerDocument, { input: { id, assetIds: [assetId] } }),
        onSuccess: () => {
            toast.success('Banner updated');
            invalidate();
        },
        onError: (e: any) => toast.error(`Update failed: ${e.message}`),
    });

    const deleteMutation = useMutation({
        mutationFn: (id: string) => api.mutate(deleteBannerDocument, { id }),
        onSuccess: () => {
            toast.success('Banner deleted');
            invalidate();
        },
        onError: (e: any) => toast.error(`Delete failed: ${e.message}`),
    });

    const banners: Banner[] = (data as any)?.customBanners?.items ?? [];

    const handlePicked = (assets: Array<BannerAsset>) => {
        const asset = assets[0];
        if (!asset) {
            setPickerMode(null);
            return;
        }
        if (pickerMode === 'create') {
            setSelectedAsset(asset);
        } else if (pickerMode === 'update' && updateTargetId) {
            updateMutation.mutate({ id: updateTargetId, assetId: asset.id });
        }
        setPickerMode(null);
        setUpdateTargetId(null);
    };

    return (
        <Page pageId="banner-list">
            <PageTitle>Banner Management</PageTitle>
            <div className="px-4 pb-6">{/* full-width container (no side column) */}
                    {/* Tabs */}
                    <div className="mb-6 flex gap-1 border-b">
                        <span className="border-primary text-primary -mb-px border-b-2 px-6 py-2.5 text-sm font-semibold">
                            Banners
                        </span>
                        <Link
                            to="/offers"
                            className="text-muted-foreground hover:text-primary -mb-px border-b-2 border-transparent px-6 py-2.5 text-sm font-medium"
                        >
                            Offers
                        </Link>
                    </div>

                    {/* Upload section */}
                    <Card className="mb-6">
                        <CardContent className="flex flex-wrap items-center justify-center gap-3 py-4">
                            <Button
                                variant="outline"
                                onClick={() => {
                                    setPickerMode('create');
                                }}
                            >
                                {selectedAsset ? 'Change image' : 'Pick from assets'}
                            </Button>
                            {selectedAsset && (
                                <img
                                    src={`${selectedAsset.preview}?preset=thumb`}
                                    alt={selectedAsset.name}
                                    className="max-h-[140px] max-w-[240px] rounded border"
                                />
                            )}
                            <Button
                                disabled={!selectedAsset || createMutation.isPending}
                                onClick={() => selectedAsset && createMutation.mutate(selectedAsset.id)}
                            >
                                Upload Banner
                            </Button>
                        </CardContent>
                    </Card>

                    {/* Banner grid */}
                    {isLoading ? (
                        <div className="flex justify-center p-6">
                            <Spinner />
                        </div>
                    ) : banners.length === 0 ? (
                        <div className="text-muted-foreground flex justify-center p-6 text-sm">
                            No banners available. Create one to get started!
                        </div>
                    ) : (
                        <div className="grid grid-cols-4 gap-4">
                            {banners.map(banner => {
                                const image = banner.assets[0];
                                return (
                                    <Card key={banner.id} className="overflow-hidden">
                                        <div className="bg-muted flex h-44 items-center justify-center overflow-hidden">
                                            {image ? (
                                                <img
                                                    src={`${image.preview}?preset=medium`}
                                                    alt={image.name}
                                                    className="h-full w-full object-cover"
                                                />
                                            ) : (
                                                <span className="text-muted-foreground p-6 text-sm">No image</span>
                                            )}
                                        </div>
                                        <CardContent className="flex justify-between gap-2 py-3">
                                            <Button
                                                size="sm"
                                                onClick={() => {
                                                    setPickerMode('update');
                                                    setUpdateTargetId(banner.id);
                                                }}
                                            >
                                                <Pencil className="mr-1 h-4 w-4" />
                                                Update Image
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="destructive"
                                                disabled={deleteMutation.isPending}
                                                onClick={() => deleteMutation.mutate(banner.id)}
                                            >
                                                <Trash2 className="mr-1 h-4 w-4" />
                                                Delete
                                            </Button>
                                        </CardContent>
                                    </Card>
                                );
                            })}
                        </div>
                    )}
            </div>

            {pickerMode && (
                <AssetPickerDialog
                    open={!!pickerMode}
                    multiSelect={false}
                    title="Select banner image"
                    onClose={() => {
                        setPickerMode(null);
                        setUpdateTargetId(null);
                    }}
                    onSelect={handlePicked as any}
                />
            )}
        </Page>
    );
}

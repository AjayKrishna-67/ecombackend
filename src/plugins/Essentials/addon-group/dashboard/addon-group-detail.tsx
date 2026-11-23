import {
    api,
    AssetPickerDialog,
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Input,
    Label,
    Page,
    PageActionBar,
    PageActionBarRight,
    PageTitle,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Spinner,
    Switch,
    toast,
    useLocalFormat,
} from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Check, ImageIcon, Pencil, Plus, Trash2, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import {
    AddonGroupDto,
    AddonItemDto,
    AssignedVariantDto,
    createAddonGroupDocument,
    createAddonItemDocument,
    deleteAddonItemDocument,
    getActiveChannelCurrencyDocument,
    getAddonGroupDocument,
    getVariantsWithAddonGroupDocument,
    updateAddonGroupDocument,
    updateAddonItemDocument,
} from './queries';

type SelectionType = 'CHECKBOX' | 'QUANTITY';
type PickedAsset = { id: string; preview: string };

interface GroupForm {
    name: string;
    description: string;
    selectionType: SelectionType;
    isRequired: boolean;
    minSelections: number;
    maxSelections: number;
    sortOrder: number;
    enabled: boolean;
}

const EMPTY_FORM: GroupForm = {
    name: '',
    description: '',
    selectionType: 'CHECKBOX',
    isRequired: false,
    minSelections: 0,
    maxSelections: 1,
    sortOrder: 0,
    enabled: true,
};

interface ItemDraft {
    name: string;
    price: number; // major units in the form
    sku: string;
    minQuantity: number;
    maxQuantity: number;
    image: PickedAsset | null;
}

const EMPTY_ITEM: ItemDraft = { name: '', price: 0, sku: '', minQuantity: 0, maxQuantity: 1, image: null };

/**
 * Addon Group create/edit page. Mirrors the old Angular addon-group-detail:
 *  - group settings form (create + update)
 *  - nested addon-item editor (add form + inline row edit + delete) — only when editing
 *  - list of variants the group is assigned to
 * Prices are entered in major units and stored as Money (minor units).
 */
export function AddonGroupDetailPage() {
    const params = useParams({ strict: false }) as { id?: string };
    const id = params.id;
    const isNew = id === 'create';
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { formatCurrency, toMajorUnits, toMinorUnits } = useLocalFormat();

    const groupKey = ['addon-group', id];
    const { data, isLoading } = useQuery({
        queryKey: groupKey,
        queryFn: () => api.query(getAddonGroupDocument, { id: id! }),
        enabled: !isNew && !!id,
    });
    const group: AddonGroupDto | null = (data as any)?.addonGroup ?? null;

    const { data: channelData } = useQuery({
        queryKey: ['addon-currency'],
        queryFn: () => api.query(getActiveChannelCurrencyDocument),
    });
    const currency: string = (channelData as any)?.activeChannel?.defaultCurrencyCode ?? 'USD';

    const { data: variantsData } = useQuery({
        queryKey: ['addon-group-variants', id],
        queryFn: () => api.query(getVariantsWithAddonGroupDocument, { addonGroupId: id! }),
        enabled: !isNew && !!id,
    });
    const assignedVariants: AssignedVariantDto[] = (variantsData as any)?.variantsWithAddonGroup ?? [];

    const [form, setForm] = useState<GroupForm>(EMPTY_FORM);
    const isCheckbox = form.selectionType === 'CHECKBOX';

    useEffect(() => {
        if (group) {
            setForm({
                name: group.name,
                description: group.description ?? '',
                selectionType: group.selectionType,
                isRequired: group.isRequired,
                minSelections: group.minSelections,
                maxSelections: group.maxSelections,
                sortOrder: group.sortOrder,
                enabled: group.enabled,
            });
        }
    }, [group]);

    const setField = <K extends keyof GroupForm>(key: K, value: GroupForm[K]) =>
        setForm(prev => ({ ...prev, [key]: value }));

    const formError = useMemo(() => {
        if (!form.name.trim()) return 'Name is required';
        if (form.name.length > 255) return 'Name is too long (max 255 characters)';
        if (form.minSelections < 0) return 'Min selections cannot be negative';
        if (form.maxSelections < 1) return 'Max selections must be at least 1';
        if (form.minSelections > form.maxSelections) return 'Min selections cannot be greater than max selections';
        if (form.isRequired && form.minSelections < 1) return 'Required groups must have min selections of at least 1';
        if (form.sortOrder < 0) return 'Sort order cannot be negative';
        return null;
    }, [form]);

    const invalidateGroup = () => queryClient.invalidateQueries({ queryKey: groupKey });

    const createGroup = useMutation({
        mutationFn: () => api.mutate(createAddonGroupDocument, { input: form }),
        onSuccess: (res: any) => {
            toast.success('Addon group created');
            queryClient.invalidateQueries({ queryKey: ['addon-groups'] });
            const newId = res?.createAddonGroup?.id;
            if (newId) navigate({ to: '/addon-groups/$id', params: { id: newId } });
        },
        onError: (e: any) => toast.error(`Create failed: ${e?.message ?? 'error'}`),
    });

    const updateGroup = useMutation({
        mutationFn: () => api.mutate(updateAddonGroupDocument, { input: { id: id!, ...form } }),
        onSuccess: () => {
            toast.success('Addon group updated');
            invalidateGroup();
            queryClient.invalidateQueries({ queryKey: ['addon-groups'] });
        },
        onError: (e: any) => toast.error(`Update failed: ${e?.message ?? 'error'}`),
    });

    // ---- item add form ----
    const [showAddItem, setShowAddItem] = useState(false);
    const [draft, setDraft] = useState<ItemDraft>(EMPTY_ITEM);
    const [pickerFor, setPickerFor] = useState<'new' | 'edit' | null>(null);

    const draftError = useMemo(() => {
        if (!draft.name.trim()) return 'Name is required';
        if (draft.name.length > 255) return 'Name is too long';
        if (draft.sku.length > 255) return 'SKU is too long';
        if (draft.price < 0) return 'Price cannot be negative';
        if (!isCheckbox) {
            if (draft.minQuantity < 0) return 'Min quantity cannot be negative';
            if (draft.maxQuantity < 1) return 'Max quantity must be at least 1';
            if (draft.minQuantity > draft.maxQuantity) return 'Min quantity cannot be greater than max quantity';
        }
        return null;
    }, [draft, isCheckbox]);

    const addItem = useMutation({
        mutationFn: () =>
            api.mutate(createAddonItemDocument, {
                input: {
                    groupId: id!,
                    name: draft.name.trim(),
                    price: toMinorUnits(draft.price || 0),
                    sku: draft.sku.trim() || null,
                    minQuantity: isCheckbox ? 0 : draft.minQuantity,
                    maxQuantity: isCheckbox ? 1 : draft.maxQuantity,
                    ...(draft.image ? { imageId: draft.image.id } : {}),
                },
            }),
        onSuccess: () => {
            toast.success('Addon item added');
            setDraft(EMPTY_ITEM);
            setShowAddItem(false);
            invalidateGroup();
        },
        onError: (e: any) => toast.error(`Add item failed: ${e?.message ?? 'error'}`),
    });

    // ---- inline edit ----
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editDraft, setEditDraft] = useState<ItemDraft & { imageChanged: boolean }>({
        ...EMPTY_ITEM,
        imageChanged: false,
    });

    const startEdit = (item: AddonItemDto) => {
        setEditingId(item.id);
        setEditDraft({
            name: item.name,
            price: toMajorUnits(item.price),
            sku: item.sku ?? '',
            minQuantity: item.minQuantity,
            maxQuantity: item.maxQuantity,
            image: item.image ? { id: item.image.id, preview: item.image.preview } : null,
            imageChanged: false,
        });
    };

    const saveEdit = useMutation({
        mutationFn: () =>
            api.mutate(updateAddonItemDocument, {
                input: {
                    id: editingId!,
                    name: editDraft.name.trim(),
                    price: toMinorUnits(editDraft.price || 0),
                    sku: editDraft.sku.trim() || null,
                    minQuantity: isCheckbox ? 0 : editDraft.minQuantity,
                    maxQuantity: isCheckbox ? 1 : editDraft.maxQuantity,
                    // Only send imageId when the picker was touched (null = explicit removal)
                    ...(editDraft.imageChanged ? { imageId: editDraft.image?.id ?? null } : {}),
                },
            }),
        onSuccess: () => {
            toast.success('Item updated');
            setEditingId(null);
            invalidateGroup();
        },
        onError: (e: any) => toast.error(`Update item failed: ${e?.message ?? 'error'}`),
    });

    const deleteItem = useMutation({
        mutationFn: (itemId: string) => api.mutate(deleteAddonItemDocument, { id: itemId }),
        onSuccess: (res: any) => {
            if (res?.deleteAddonItem?.result === 'DELETED') {
                toast.success('Item deleted');
            } else {
                toast.error(res?.deleteAddonItem?.message ?? 'Could not delete item');
            }
            invalidateGroup();
        },
        onError: (e: any) => toast.error(`Delete item failed: ${e?.message ?? 'error'}`),
    });

    const onAssetPicked = (assets: Array<{ id: string; preview: string }>) => {
        const asset = assets?.[0];
        if (asset) {
            const picked = { id: asset.id, preview: asset.preview };
            if (pickerFor === 'new') setDraft(prev => ({ ...prev, image: picked }));
            else if (pickerFor === 'edit') setEditDraft(prev => ({ ...prev, image: picked, imageChanged: true }));
        }
        setPickerFor(null);
    };

    if (!isNew && isLoading) {
        return (
            <Page pageId="addon-group-detail">
                <div className="flex justify-center p-10">
                    <Spinner />
                </div>
            </Page>
        );
    }

    const items = group?.items ?? [];

    return (
        <Page pageId="addon-group-detail">
            <PageTitle>{isNew ? 'New Addon Group' : `Addon Group: ${group?.name ?? ''}`}</PageTitle>
            <PageActionBar>
                <PageActionBarRight>
                    <Button variant="outline" onClick={() => navigate({ to: '/addon-groups' })}>
                        <ArrowLeft className="mr-1 h-4 w-4" />
                        Back
                    </Button>
                    <Button
                        disabled={!!formError || createGroup.isPending || updateGroup.isPending}
                        onClick={() => (isNew ? createGroup.mutate() : updateGroup.mutate())}
                    >
                        {isNew ? 'Create' : 'Update'}
                    </Button>
                </PageActionBarRight>
            </PageActionBar>

            <div className="space-y-6 px-4 pb-6">
                {/* Group settings */}
                <Card>
                    <CardHeader>
                        <CardTitle>{isNew ? 'Create Addon Group' : 'Edit Addon Group'}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-1">
                            <Label>Name</Label>
                            <Input
                                value={form.name}
                                onChange={e => setField('name', e.target.value)}
                                placeholder="e.g. Gift Options"
                            />
                        </div>
                        <div className="space-y-1">
                            <Label>Description</Label>
                            <Input
                                value={form.description}
                                onChange={e => setField('description', e.target.value)}
                                placeholder="Optional"
                            />
                        </div>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div className="space-y-1">
                                <Label>Selection Type</Label>
                                <Select
                                    value={form.selectionType}
                                    onValueChange={val => val && setField('selectionType', val as SelectionType)}
                                >
                                    <SelectTrigger className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="CHECKBOX">Checkbox (toggle on/off)</SelectItem>
                                        <SelectItem value="QUANTITY">Quantity (with min/max count)</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="flex items-center gap-3 pt-6">
                                <Switch
                                    checked={form.isRequired}
                                    onCheckedChange={checked => setField('isRequired', checked)}
                                />
                                <span className="text-sm">Required</span>
                            </div>
                        </div>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                            <div className="space-y-1">
                                <Label>Min Selections</Label>
                                <Input
                                    type="number"
                                    min={0}
                                    value={form.minSelections}
                                    onChange={e => setField('minSelections', Number(e.target.value))}
                                />
                            </div>
                            <div className="space-y-1">
                                <Label>Max Selections</Label>
                                <Input
                                    type="number"
                                    min={1}
                                    value={form.maxSelections}
                                    onChange={e => setField('maxSelections', Number(e.target.value))}
                                />
                            </div>
                            <div className="space-y-1">
                                <Label>Sort Order</Label>
                                <Input
                                    type="number"
                                    value={form.sortOrder}
                                    onChange={e => setField('sortOrder', Number(e.target.value))}
                                />
                            </div>
                        </div>
                        <div className="flex items-center gap-3">
                            <Switch checked={form.enabled} onCheckedChange={checked => setField('enabled', checked)} />
                            <span className="text-sm">Enabled</span>
                        </div>
                        {formError && <p className="text-destructive text-sm">{formError}</p>}
                    </CardContent>
                </Card>

                {/* Addon items — only when editing an existing group */}
                {!isNew && (
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between">
                            <CardTitle>Addon Items ({items.length})</CardTitle>
                            <Button variant="secondary" size="sm" onClick={() => setShowAddItem(v => !v)}>
                                <Plus className="mr-1 h-4 w-4" />
                                Add Item
                            </Button>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            {showAddItem && (
                                <div className="bg-muted/40 space-y-3 rounded-lg border p-4">
                                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                        <div className="space-y-1">
                                            <Label>Name</Label>
                                            <Input
                                                value={draft.name}
                                                onChange={e => setDraft({ ...draft, name: e.target.value })}
                                                placeholder="e.g. Gift Wrap"
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <Label>Price ({currency})</Label>
                                            <Input
                                                type="number"
                                                min={0}
                                                step="0.01"
                                                value={draft.price}
                                                onChange={e => setDraft({ ...draft, price: Number(e.target.value) })}
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <Label>SKU</Label>
                                            <Input
                                                value={draft.sku}
                                                onChange={e => setDraft({ ...draft, sku: e.target.value })}
                                                placeholder="Optional"
                                            />
                                        </div>
                                        {!isCheckbox && (
                                            <div className="grid grid-cols-2 gap-3">
                                                <div className="space-y-1">
                                                    <Label>Min Qty</Label>
                                                    <Input
                                                        type="number"
                                                        min={0}
                                                        value={draft.minQuantity}
                                                        onChange={e =>
                                                            setDraft({ ...draft, minQuantity: Number(e.target.value) })
                                                        }
                                                    />
                                                </div>
                                                <div className="space-y-1">
                                                    <Label>Max Qty</Label>
                                                    <Input
                                                        type="number"
                                                        min={1}
                                                        value={draft.maxQuantity}
                                                        onChange={e =>
                                                            setDraft({ ...draft, maxQuantity: Number(e.target.value) })
                                                        }
                                                    />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-3">
                                        {draft.image && (
                                            <img
                                                src={`${draft.image.preview}?preset=tiny`}
                                                className="border-border h-10 w-10 rounded border object-cover"
                                                alt=""
                                            />
                                        )}
                                        <Button variant="outline" size="sm" onClick={() => setPickerFor('new')}>
                                            <ImageIcon className="mr-1 h-4 w-4" />
                                            {draft.image ? 'Change' : 'Select'} Image
                                        </Button>
                                        {draft.image && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => setDraft({ ...draft, image: null })}
                                            >
                                                Remove
                                            </Button>
                                        )}
                                    </div>
                                    {isCheckbox && (
                                        <p className="text-muted-foreground text-xs italic">
                                            Quantity is fixed to 1 for checkbox-type groups.
                                        </p>
                                    )}
                                    {draftError && <p className="text-destructive text-sm">{draftError}</p>}
                                    <div className="flex justify-end gap-2">
                                        <Button variant="ghost" size="sm" onClick={() => setShowAddItem(false)}>
                                            Cancel
                                        </Button>
                                        <Button
                                            size="sm"
                                            disabled={!!draftError || addItem.isPending}
                                            onClick={() => addItem.mutate()}
                                        >
                                            Save Item
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {items.length === 0 ? (
                                <div className="text-muted-foreground py-6 text-center text-sm">
                                    No addon items yet. Add items customers can select.
                                </div>
                            ) : (
                                <div className="divide-border overflow-hidden rounded-lg border">
                                    {items.map(item =>
                                        editingId === item.id ? (
                                            <div key={item.id} className="bg-muted/30 space-y-3 p-3">
                                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                                    <Input
                                                        value={editDraft.name}
                                                        onChange={e =>
                                                            setEditDraft({ ...editDraft, name: e.target.value })
                                                        }
                                                        placeholder="Name"
                                                    />
                                                    <Input
                                                        type="number"
                                                        min={0}
                                                        step="0.01"
                                                        value={editDraft.price}
                                                        onChange={e =>
                                                            setEditDraft({ ...editDraft, price: Number(e.target.value) })
                                                        }
                                                        placeholder="Price"
                                                    />
                                                    <Input
                                                        value={editDraft.sku}
                                                        onChange={e =>
                                                            setEditDraft({ ...editDraft, sku: e.target.value })
                                                        }
                                                        placeholder="SKU"
                                                    />
                                                    {!isCheckbox && (
                                                        <div className="grid grid-cols-2 gap-2">
                                                            <Input
                                                                type="number"
                                                                min={0}
                                                                value={editDraft.minQuantity}
                                                                onChange={e =>
                                                                    setEditDraft({
                                                                        ...editDraft,
                                                                        minQuantity: Number(e.target.value),
                                                                    })
                                                                }
                                                                placeholder="Min"
                                                            />
                                                            <Input
                                                                type="number"
                                                                min={1}
                                                                value={editDraft.maxQuantity}
                                                                onChange={e =>
                                                                    setEditDraft({
                                                                        ...editDraft,
                                                                        maxQuantity: Number(e.target.value),
                                                                    })
                                                                }
                                                                placeholder="Max"
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-3">
                                                    {editDraft.image && (
                                                        <img
                                                            src={`${editDraft.image.preview}?preset=tiny`}
                                                            className="border-border h-10 w-10 rounded border object-cover"
                                                            alt=""
                                                        />
                                                    )}
                                                    <Button variant="outline" size="sm" onClick={() => setPickerFor('edit')}>
                                                        <ImageIcon className="mr-1 h-4 w-4" />
                                                        {editDraft.image ? 'Change' : 'Select'} Image
                                                    </Button>
                                                    {editDraft.image && (
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() =>
                                                                setEditDraft({
                                                                    ...editDraft,
                                                                    image: null,
                                                                    imageChanged: true,
                                                                })
                                                            }
                                                        >
                                                            Remove
                                                        </Button>
                                                    )}
                                                    <div className="ml-auto flex gap-2">
                                                        <Button
                                                            size="sm"
                                                            disabled={saveEdit.isPending}
                                                            onClick={() => saveEdit.mutate()}
                                                        >
                                                            <Check className="mr-1 h-4 w-4" />
                                                            Save
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() => setEditingId(null)}
                                                        >
                                                            <X className="mr-1 h-4 w-4" />
                                                            Cancel
                                                        </Button>
                                                    </div>
                                                </div>
                                            </div>
                                        ) : (
                                            <div
                                                key={item.id}
                                                className="hover:bg-muted/40 flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
                                            >
                                                {item.image?.preview ? (
                                                    <img
                                                        src={`${item.image.preview}?preset=tiny`}
                                                        className="border-border h-10 w-10 rounded border object-cover"
                                                        alt=""
                                                    />
                                                ) : (
                                                    <div className="bg-muted h-10 w-10 rounded border" />
                                                )}
                                                <div className="flex-1">
                                                    <div className="flex items-center gap-2 text-sm font-medium">
                                                        {item.name}
                                                        <span
                                                            className={`inline-block h-2 w-2 rounded-full ${
                                                                item.enabled ? 'bg-green-500' : 'bg-red-500'
                                                            }`}
                                                        />
                                                    </div>
                                                    <div className="text-muted-foreground text-xs">
                                                        {formatCurrency(item.price, currency)}
                                                        {item.sku ? ` · ${item.sku}` : ''}
                                                        {!isCheckbox ? ` · qty ${item.minQuantity}–${item.maxQuantity}` : ''}
                                                    </div>
                                                </div>
                                                <button
                                                    type="button"
                                                    className="hover:bg-muted text-muted-foreground rounded-sm p-1.5"
                                                    aria-label="Edit item"
                                                    onClick={() => startEdit(item)}
                                                >
                                                    <Pencil className="h-4 w-4" />
                                                </button>
                                                <button
                                                    type="button"
                                                    className="hover:bg-destructive/20 hover:text-destructive text-muted-foreground rounded-sm p-1.5"
                                                    aria-label="Delete item"
                                                    onClick={() => deleteItem.mutate(item.id)}
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                </button>
                                            </div>
                                        ),
                                    )}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                )}

                {/* Assigned variants */}
                {!isNew && (
                    <Card>
                        <CardHeader>
                            <CardTitle>
                                Assigned Products ({assignedVariants.length} variant
                                {assignedVariants.length === 1 ? '' : 's'})
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            {assignedVariants.length === 0 ? (
                                <div className="text-muted-foreground py-4 text-center text-sm">
                                    No products assigned yet. Assign this group from a product variant&apos;s custom
                                    fields.
                                </div>
                            ) : (
                                <div className="divide-border overflow-hidden rounded-lg border">
                                    {assignedVariants.map(v => (
                                        <Link
                                            key={v.id}
                                            to="/products/$id"
                                            params={{ id: v.productId }}
                                            className="hover:bg-muted/40 flex items-center justify-between gap-2 border-b px-3 py-2 text-sm last:border-b-0"
                                        >
                                            <span>
                                                <strong>{v.productName}</strong> — {v.name}
                                            </span>
                                            {v.sku && (
                                                <Badge variant="outline" className="text-xs">
                                                    {v.sku}
                                                </Badge>
                                            )}
                                        </Link>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                )}
            </div>

            {pickerFor && (
                <AssetPickerDialog
                    open={!!pickerFor}
                    multiSelect={false}
                    title="Select addon item image"
                    onClose={() => setPickerFor(null)}
                    onSelect={onAssetPicked as any}
                />
            )}
        </Page>
    );
}

import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    api,
    Badge,
    Button,
    Card,
    CardContent,
    Input,
    Page,
    PageActionBar,
    PageActionBarRight,
    PageTitle,
    Spinner,
    toast,
    usePermissions,
} from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, PackagePlus, Plus, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import { AddonGroupDto, deleteAddonGroupDocument, getAddonGroupsDocument } from './queries';

const PAGE_SIZE = 25;
const LIST_KEY = ['addon-groups'];

/**
 * Addon Groups management list (Catalog → Addon Groups). Server-paginated;
 * a numeric search term matches by id, otherwise by name contains. Delete is
 * guarded by an AlertDialog. Mirrors the old Angular addon-group-list.
 */
export function AddonGroupListPage() {
    const queryClient = useQueryClient();
    const { hasPermissions } = usePermissions();
    const canDelete = hasPermissions(['DeleteAddonGroup']);
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(0);
    const [deleteTarget, setDeleteTarget] = useState<AddonGroupDto | null>(null);

    const term = search.trim();
    const filter = term ? (/^\d+$/.test(term) ? { id: { eq: term } } : { name: { contains: term } }) : {};
    const queryKey = [...LIST_KEY, page, term];

    const { data, isLoading } = useQuery({
        queryKey,
        queryFn: () =>
            api.query(getAddonGroupsDocument, {
                options: { skip: page * PAGE_SIZE, take: PAGE_SIZE, filter, sort: { createdAt: 'DESC' } },
            }),
    });

    const groups: AddonGroupDto[] = (data as any)?.addonGroups?.items ?? [];
    const totalItems: number = (data as any)?.addonGroups?.totalItems ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));

    const deleteGroup = useMutation({
        mutationFn: (id: string) => api.mutate(deleteAddonGroupDocument, { id }),
        onSuccess: (res: any) => {
            if (res?.deleteAddonGroup?.result === 'DELETED') {
                toast.success('Addon group deleted');
            } else {
                toast.error(res?.deleteAddonGroup?.message ?? 'Could not delete addon group');
            }
            setDeleteTarget(null);
            queryClient.invalidateQueries({ queryKey: LIST_KEY });
        },
        onError: (e: any) => {
            toast.error(`Delete failed: ${e?.message ?? 'error'}`);
            setDeleteTarget(null);
        },
    });

    return (
        <Page pageId="addon-group-list">
            <PageTitle>Addon Groups</PageTitle>
            <PageActionBar>
                <PageActionBarRight>
                    <Button render={<Link to="/addon-groups/$id" params={{ id: 'create' }} />}>
                        <Plus className="mr-1 h-4 w-4" />
                        Add Addon Group
                    </Button>
                </PageActionBarRight>
            </PageActionBar>

            <div className="px-4 pb-6">
                <Card>
                    <CardContent className="space-y-4 pt-6">
                        <div className="flex items-center justify-between gap-3">
                            <Input
                                placeholder="Filter by name or id…"
                                className="max-w-xs"
                                value={search}
                                onChange={e => {
                                    setSearch(e.target.value);
                                    setPage(0);
                                }}
                            />
                            <span className="text-muted-foreground text-sm">
                                {totalItems} group{totalItems === 1 ? '' : 's'}
                            </span>
                        </div>

                        {isLoading ? (
                            <div className="flex justify-center p-8">
                                <Spinner />
                            </div>
                        ) : groups.length === 0 ? (
                            <div className="border-border/60 text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center text-sm">
                                <PackagePlus className="h-6 w-6 opacity-60" />
                                {term ? 'No addon groups match your search.' : 'No addon groups yet. Create one to get started.'}
                            </div>
                        ) : (
                            <div className="divide-border overflow-hidden rounded-lg border">
                                {groups.map(group => (
                                    <div
                                        key={group.id}
                                        className="hover:bg-muted/40 flex items-center justify-between gap-3 border-b px-3 py-2.5 last:border-b-0"
                                    >
                                        <Link
                                            to="/addon-groups/$id"
                                            params={{ id: group.id }}
                                            className="flex flex-1 items-center gap-3 text-sm"
                                        >
                                            <span className="font-medium">{group.name}</span>
                                            <Badge variant={group.selectionType === 'CHECKBOX' ? 'secondary' : 'outline'}>
                                                {group.selectionType === 'CHECKBOX' ? 'Checkbox' : 'Quantity'}
                                            </Badge>
                                            {group.isRequired && (
                                                <Badge variant="destructive" className="text-xs">
                                                    Required
                                                </Badge>
                                            )}
                                            <span className="text-muted-foreground text-xs">
                                                {group.items.length} item{group.items.length === 1 ? '' : 's'}
                                            </span>
                                            <Badge variant={group.enabled ? 'secondary' : 'outline'} className="text-xs">
                                                {group.enabled ? 'Active' : 'Disabled'}
                                            </Badge>
                                            <ChevronRight className="text-muted-foreground ml-auto h-4 w-4" />
                                        </Link>
                                        {canDelete && (
                                            <button
                                                type="button"
                                                aria-label={`Delete ${group.name}`}
                                                className="hover:bg-destructive/20 hover:text-destructive text-muted-foreground rounded-sm p-1.5"
                                                onClick={() => setDeleteTarget(group)}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        {totalPages > 1 && (
                            <div className="flex items-center justify-end gap-2 text-sm">
                                <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                                    Previous
                                </Button>
                                <span className="text-muted-foreground">
                                    Page {page + 1} of {totalPages}
                                </span>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={page >= totalPages - 1}
                                    onClick={() => setPage(p => p + 1)}
                                >
                                    Next
                                </Button>
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete &ldquo;{deleteTarget?.name}&rdquo;?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This deletes the addon group and all of its items. Variants currently referencing it will
                            lose the group. This cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            disabled={deleteGroup.isPending}
                            onClick={() => deleteTarget && deleteGroup.mutate(deleteTarget.id)}
                        >
                            {deleteGroup.isPending ? 'Deleting…' : 'Delete'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Page>
    );
}

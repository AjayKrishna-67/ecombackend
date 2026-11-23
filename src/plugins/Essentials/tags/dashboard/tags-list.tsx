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
    PageTitle,
    Spinner,
    toast,
    usePermissions,
} from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Tag as TagIcon, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import { catalogTagsDocument, deleteCatalogTagDocument, TagDto } from './queries';

const QUERY_KEY = ['catalog-tags'];

/**
 * Tags management page (Settings → Tags). Lists every tag (global — tags are
 * shared across all channels) and allows delete. Deleting a tag removes it from
 * all products and variants (join rows cascade).
 */
export function TagsListPage() {
    const queryClient = useQueryClient();
    const { hasPermissions } = usePermissions();
    const canDelete = hasPermissions(['DeleteCatalog']);
    const [search, setSearch] = useState('');
    const [deleteTarget, setDeleteTarget] = useState<TagDto | null>(null);

    const { data, isLoading } = useQuery({
        queryKey: QUERY_KEY,
        queryFn: () => api.query(catalogTagsDocument, {}),
    });
    const invalidate = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

    const tags: TagDto[] = (data as any)?.catalogTags ?? [];
    const filtered = search.trim()
        ? tags.filter(t => t.key.includes(search.trim().toLowerCase()))
        : tags;

    const deleteTag = useMutation({
        mutationFn: (id: string) => api.mutate(deleteCatalogTagDocument, { id }),
        onSuccess: (res: any) => {
            if (res?.deleteCatalogTag?.result === 'DELETED') {
                toast.success('Tag deleted');
            } else {
                toast.error(res?.deleteCatalogTag?.message ?? 'Could not delete tag');
            }
            setDeleteTarget(null);
            invalidate();
        },
        onError: (e: any) => {
            toast.error(`Delete failed: ${e?.message ?? 'error'}`);
            setDeleteTarget(null);
        },
    });

    return (
        <Page pageId="tags-list">
            <PageTitle>Tags</PageTitle>
            <Card>
                <CardContent className="space-y-4 pt-6">
                    <div className="flex items-center justify-between gap-3">
                        <Input
                            placeholder="Search tags…"
                            className="max-w-xs"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                        />
                        <span className="text-muted-foreground text-sm">
                            {filtered.length} tag{filtered.length === 1 ? '' : 's'}
                        </span>
                    </div>

                    {isLoading ? (
                        <div className="flex justify-center p-8">
                            <Spinner />
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="border-border/60 text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center text-sm">
                            <TagIcon className="h-6 w-6 opacity-60" />
                            {tags.length === 0
                                ? 'No tags yet. Add tags from a product or variant detail page.'
                                : 'No tags match your search.'}
                        </div>
                    ) : (
                        <div className="divide-border overflow-hidden rounded-lg border">
                            {filtered.map(tag => (
                                <div
                                    key={tag.id}
                                    className="hover:bg-muted/40 flex items-center justify-between gap-3 border-b px-3 py-2 last:border-b-0"
                                >
                                    <Link
                                        to="/tags/$id"
                                        params={{ id: tag.id }}
                                        className="flex flex-1 items-center gap-3 text-sm"
                                    >
                                        <Badge variant="secondary" className="font-medium">
                                            {tag.value}
                                        </Badge>
                                        <span className="text-muted-foreground text-xs">
                                            {tag.productCount ?? 0} product{(tag.productCount ?? 0) === 1 ? '' : 's'}
                                            {' · '}
                                            {tag.variantCount ?? 0} variant{(tag.variantCount ?? 0) === 1 ? '' : 's'}
                                        </span>
                                        <ChevronRight className="text-muted-foreground h-4 w-4" />
                                    </Link>
                                    {canDelete && (
                                        <button
                                            type="button"
                                            aria-label={`Delete ${tag.value}`}
                                            className="hover:bg-destructive/20 hover:text-destructive text-muted-foreground rounded-sm p-1.5"
                                            onClick={() => setDeleteTarget(tag)}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete tag &ldquo;{deleteTarget?.value}&rdquo;?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This removes the tag from every product and variant it is attached to. This
                            cannot be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            disabled={deleteTag.isPending}
                            onClick={() => deleteTarget && deleteTag.mutate(deleteTarget.id)}
                        >
                            {deleteTag.isPending ? 'Deleting…' : 'Delete'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Page>
    );
}

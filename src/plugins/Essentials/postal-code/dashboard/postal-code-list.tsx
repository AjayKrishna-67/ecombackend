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
    Page,
    PageTitle,
    Spinner,
    toast,
} from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle, ChevronLeft, ChevronRight, Globe, MapPin, Plus, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import {
    createPostalCodeDocument,
    deletePostalCodeDocument,
    getPostalCodesDocument,
    PostalCode,
} from './queries';

const QUERY_KEY = ['postal-codes'];

export function PostalCodeListPage() {
    const queryClient = useQueryClient();
    const [page, setPage] = useState(1);
    const [perPage, setPerPage] = useState(16);
    const [deleteTarget, setDeleteTarget] = useState<PostalCode | null>(null);

    const { data, isLoading } = useQuery({
        queryKey: QUERY_KEY,
        queryFn: () => api.query(getPostalCodesDocument, { options: { take: 2000 } }),
    });
    const invalidate = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

    const items: PostalCode[] = (data as any)?.postalCodes?.items ?? [];
    const anywhereItem = items.find(i => i.isAnywhere) ?? null;
    const mode: 'anywhere' | 'predefined' = anywhereItem ? 'anywhere' : 'predefined';
    const predefined = items.filter(i => !i.isAnywhere);
    const total = predefined.length;
    const paged = predefined.slice((page - 1) * perPage, page * perPage);

    const enableAnywhere = useMutation({
        mutationFn: () => api.mutate(createPostalCodeDocument, { input: { code: 'ANYWHERE', isAnywhere: true } }),
        onSuccess: () => {
            toast.success('Now accepting all postal codes');
            invalidate();
        },
        onError: (e: any) => toast.error(`Failed: ${e.message}`),
    });
    const disableAnywhere = useMutation({
        mutationFn: () => api.mutate(deletePostalCodeDocument, { id: anywhereItem!.id }),
        onSuccess: () => {
            toast.success('Now using specific postal codes');
            invalidate();
        },
        onError: (e: any) => toast.error(`Failed: ${e.message}`),
    });
    const deleteMutation = useMutation({
        mutationFn: (id: string) => api.mutate(deletePostalCodeDocument, { id }),
        onSuccess: () => {
            toast.success('Postal code removed');
            invalidate();
        },
        onError: (e: any) => toast.error(`Failed: ${e.message}`),
    });

    const setMode = (next: 'anywhere' | 'predefined') => {
        if (next === mode) return;
        if (next === 'anywhere') enableAnywhere.mutate();
        else disableAnywhere.mutate();
    };

    return (
        <Page pageId="postal-code-list">
            <PageTitle>Postal Codes</PageTitle>
            <div className="space-y-6 px-4 pb-6">
                {/* Mode card */}
                <Card>
                    <CardContent className="flex items-center justify-between py-4">
                        <div className="flex items-center gap-4">
                            <div
                                className={
                                    'flex h-12 w-12 items-center justify-center rounded-xl text-white ' +
                                    (mode === 'anywhere' ? 'bg-blue-600' : 'bg-emerald-600')
                                }
                            >
                                {mode === 'anywhere' ? <Globe className="h-6 w-6" /> : <MapPin className="h-6 w-6" />}
                            </div>
                            <div>
                                <h3 className="font-semibold">
                                    {mode === 'anywhere' ? 'All Areas' : 'Specific Areas'}
                                </h3>
                                <p className="text-muted-foreground text-sm">
                                    {mode === 'anywhere'
                                        ? 'Accepting orders from all postal codes'
                                        : 'Only accepting orders from listed postal codes'}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-1">
                            <Button
                                size="sm"
                                variant={mode === 'anywhere' ? 'default' : 'outline'}
                                onClick={() => setMode('anywhere')}
                            >
                                All
                            </Button>
                            <Button
                                size="sm"
                                variant={mode === 'predefined' ? 'default' : 'outline'}
                                onClick={() => setMode('predefined')}
                            >
                                Specific
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                {isLoading ? (
                    <div className="flex justify-center p-6">
                        <Spinner />
                    </div>
                ) : mode === 'anywhere' ? (
                    <Card>
                        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-600 text-white">
                                <CheckCircle className="h-10 w-10" />
                            </div>
                            <h3 className="text-xl font-semibold">Delivering Everywhere</h3>
                            <p className="text-muted-foreground text-sm">
                                Your store accepts orders from all postal codes without restriction.
                            </p>
                        </CardContent>
                    </Card>
                ) : (
                    <>
                        <div className="flex items-center justify-between">
                            <div className="text-muted-foreground text-sm">
                                <span className="text-primary font-semibold">{total}</span> postal codes configured
                            </div>
                            <Button render={<Link to="/postal-codes/$id" params={{ id: 'create' }} />}>
                                <Plus className="mr-1 h-4 w-4" />
                                Add Postal Code
                            </Button>
                        </div>

                        {total === 0 ? (
                            <Card>
                                <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                                    <div className="bg-muted text-muted-foreground flex h-20 w-20 items-center justify-center rounded-full">
                                        <MapPin className="h-10 w-10" />
                                    </div>
                                    <h3 className="text-xl font-semibold">No Postal Codes Yet</h3>
                                    <p className="text-muted-foreground text-sm">
                                        Start by adding postal codes where you provide delivery service.
                                    </p>
                                    <Button render={<Link to="/postal-codes/$id" params={{ id: 'create' }} />}>
                                        <Plus className="mr-1 h-4 w-4" />
                                        Add Your First Postal Code
                                    </Button>
                                </CardContent>
                            </Card>
                        ) : (
                            <Card>
                                <CardContent className="py-4">
                                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                                        {paged.map(pc => (
                                            <Link
                                                key={pc.id}
                                                to="/postal-codes/$id"
                                                params={{ id: pc.id }}
                                                className="bg-card hover:border-primary group relative flex flex-col items-center justify-center gap-2 rounded-xl border p-4 transition hover:shadow-md"
                                            >
                                                <div className="bg-primary/10 text-primary flex h-9 w-9 items-center justify-center rounded-full">
                                                    <MapPin className="h-4 w-4" />
                                                </div>
                                                <div className="font-mono text-base font-bold tracking-wider">
                                                    {pc.code}
                                                </div>
                                                {pc.areas?.length > 0 ? (
                                                    <Badge variant="secondary" className="gap-1 text-xs">
                                                        {pc.areas.length} area{pc.areas.length > 1 ? 's' : ''}
                                                    </Badge>
                                                ) : (
                                                    <span className="text-muted-foreground text-xs">No areas</span>
                                                )}
                                                <button
                                                    type="button"
                                                    title="Delete"
                                                    onClick={e => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        setDeleteTarget(pc);
                                                    }}
                                                    className="text-muted-foreground absolute right-1.5 top-1.5 rounded p-1 opacity-0 transition hover:bg-red-500 hover:text-white group-hover:opacity-100"
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </button>
                                            </Link>
                                        ))}
                                    </div>

                                    <div className="mt-4 flex items-center justify-between border-t pt-4">
                                        <select
                                            value={perPage}
                                            onChange={e => {
                                                setPerPage(Number(e.target.value));
                                                setPage(1);
                                            }}
                                            className="bg-background rounded border px-2 py-1 text-sm"
                                        >
                                            <option value={16}>16 per page</option>
                                            <option value={32}>32 per page</option>
                                            <option value={64}>64 per page</option>
                                        </select>
                                        <div className="text-muted-foreground text-sm">
                                            Showing {(page - 1) * perPage + 1} - {Math.min(page * perPage, total)} of {total}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                disabled={page === 1}
                                                onClick={() => setPage(p => Math.max(1, p - 1))}
                                            >
                                                <ChevronLeft className="h-4 w-4" />
                                            </Button>
                                            <span className="text-sm font-semibold">{page}</span>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                disabled={page * perPage >= total}
                                                onClick={() => setPage(p => p + 1)}
                                            >
                                                <ChevronRight className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        )}
                    </>
                )}
            </div>

            <AlertDialog open={!!deleteTarget} onOpenChange={open => !open && setDeleteTarget(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Remove Postal Code</AlertDialogTitle>
                        <AlertDialogDescription>
                            Remove &quot;{deleteTarget?.code}&quot; from your serviceable areas?
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
                                setDeleteTarget(null);
                            }}
                        >
                            Remove
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Page>
    );
}

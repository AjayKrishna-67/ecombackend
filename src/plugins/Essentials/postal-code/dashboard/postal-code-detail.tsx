import {
    api,
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
    Spinner,
    Switch,
    toast,
} from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import {
    createAreaDocument,
    createPostalCodeDocument,
    deleteAreaDocument,
    getPostalCodeDocument,
    PostalCode,
    PostalCodeArea,
    updateAreaDocument,
    updatePostalCodeDocument,
} from './queries';

export function PostalCodeDetailPage() {
    const params = useParams({ strict: false }) as { id?: string };
    const id = params.id;
    const isNew = id === 'create';
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    const queryKey = ['postal-code', id];
    const { data, isLoading } = useQuery({
        queryKey,
        queryFn: () => api.query(getPostalCodeDocument, { id: id! }),
        enabled: !isNew && !!id,
    });
    const postalCode: PostalCode | null = (data as any)?.postalCode ?? null;
    const areas: PostalCodeArea[] = postalCode?.areas ?? [];

    const [code, setCode] = useState('');
    const [newAreaName, setNewAreaName] = useState('');

    useEffect(() => {
        if (postalCode) {
            setCode(postalCode.code);
        }
    }, [postalCode]);

    const invalidate = () => queryClient.invalidateQueries({ queryKey });

    const createMutation = useMutation({
        mutationFn: () => api.mutate(createPostalCodeDocument, { input: { code } }),
        onSuccess: (res: any) => {
            toast.success('Postal code created');
            const newId = res?.createPostalCode?.id;
            queryClient.invalidateQueries({ queryKey: ['postal-codes'] });
            if (newId) navigate({ to: '/postal-codes/$id', params: { id: newId } });
        },
        onError: (e: any) => toast.error(`Create failed: ${e.message}`),
    });
    const updateMutation = useMutation({
        mutationFn: () => api.mutate(updatePostalCodeDocument, { input: { id: id!, code } }),
        onSuccess: () => {
            toast.success('Postal code updated');
            invalidate();
            queryClient.invalidateQueries({ queryKey: ['postal-codes'] });
        },
        onError: (e: any) => toast.error(`Update failed: ${e.message}`),
    });

    const addAreaMutation = useMutation({
        mutationFn: () => api.mutate(createAreaDocument, { input: { postalCodeId: id!, name: newAreaName.trim() } }),
        onSuccess: () => {
            setNewAreaName('');
            invalidate();
        },
        onError: (e: any) => toast.error(`Add area failed: ${e.message}`),
    });
    const updateAreaMutation = useMutation({
        mutationFn: (input: { id: string; name?: string; enabled?: boolean }) =>
            api.mutate(updateAreaDocument, { input }),
        onSuccess: () => invalidate(),
        onError: (e: any) => toast.error(`Update area failed: ${e.message}`),
    });
    const deleteAreaMutation = useMutation({
        mutationFn: (areaId: string) => api.mutate(deleteAreaDocument, { id: areaId }),
        onSuccess: () => {
            toast.success('Area removed');
            invalidate();
        },
        onError: (e: any) => toast.error(`Delete area failed: ${e.message}`),
    });

    return (
        <Page pageId="postal-code-detail">
            <PageTitle>{isNew ? 'New Postal Code' : `Postal Code ${postalCode?.code ?? ''}`}</PageTitle>
            <PageActionBar>
                <PageActionBarRight>
                    <Button variant="outline" onClick={() => navigate({ to: '/postal-codes' })}>
                        <ArrowLeft className="mr-1 h-4 w-4" />
                        Back
                    </Button>
                    <Button
                        disabled={!code.trim() || createMutation.isPending || updateMutation.isPending}
                        onClick={() => (isNew ? createMutation.mutate() : updateMutation.mutate())}
                    >
                        {isNew ? 'Create' : 'Update'}
                    </Button>
                </PageActionBarRight>
            </PageActionBar>

            <div className="space-y-6 px-4 pb-6">
                {!isNew && isLoading ? (
                    <div className="flex justify-center p-6">
                        <Spinner />
                    </div>
                ) : (
                    <>
                        <Card>
                            <CardHeader>
                                <CardTitle>Postal Code</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-1">
                                    <Label>Code</Label>
                                    <Input value={code} onChange={e => setCode(e.target.value)} placeholder="e.g. 625001" />
                                </div>
                            </CardContent>
                        </Card>

                        {!isNew && (
                            <Card>
                                <CardHeader>
                                    <CardTitle>Areas</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <div className="flex gap-2">
                                        <Input
                                            value={newAreaName}
                                            placeholder="Add an area name"
                                            onChange={e => setNewAreaName(e.target.value)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter' && newAreaName.trim()) addAreaMutation.mutate();
                                            }}
                                        />
                                        <Button
                                            disabled={!newAreaName.trim() || addAreaMutation.isPending}
                                            onClick={() => addAreaMutation.mutate()}
                                        >
                                            <Plus className="mr-1 h-4 w-4" />
                                            Add
                                        </Button>
                                    </div>

                                    {areas.length === 0 ? (
                                        <div className="text-muted-foreground py-4 text-center text-sm">
                                            No areas yet.
                                        </div>
                                    ) : (
                                        <div className="divide-y rounded border">
                                            {areas.map(area => (
                                                <div key={area.id} className="flex items-center gap-3 p-2">
                                                    <Input
                                                        defaultValue={area.name}
                                                        className="flex-1"
                                                        onBlur={e => {
                                                            const name = e.target.value.trim();
                                                            if (name && name !== area.name) {
                                                                updateAreaMutation.mutate({ id: area.id, name });
                                                            }
                                                        }}
                                                    />
                                                    <div className="flex w-20 items-center gap-2 text-sm">
                                                        <Switch
                                                            checked={area.enabled}
                                                            onCheckedChange={checked =>
                                                                updateAreaMutation.mutate({
                                                                    id: area.id,
                                                                    enabled: checked,
                                                                })
                                                            }
                                                        />
                                                        <span
                                                            className={
                                                                area.enabled ? 'text-foreground' : 'text-muted-foreground'
                                                            }
                                                        >
                                                            {area.enabled ? 'Enabled' : 'Disabled'}
                                                        </span>
                                                    </div>
                                                    <Button
                                                        size="sm"
                                                        variant="destructive"
                                                        onClick={() => deleteAreaMutation.mutate(area.id)}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )}
                    </>
                )}
            </div>
        </Page>
    );
}

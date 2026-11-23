import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Button, Card, CardContent, Input, toast, usePermissions } from '@vendure/dashboard';
import React, { useEffect, useState } from 'react';

import { setShiprocketConfigDocument, shiprocketConfigDocument } from './queries';

const CONFIG_KEY = 'shiprocket.config';

interface BoxBracket {
    maxGrams: number;
    length: number;
    breadth: number;
    height: number;
}

interface ShiprocketConfig {
    pickupPincode: string;
    pickupLocationName: string;
    fxRate: number;
    boxBrackets: BoxBracket[];
}

// Mirrors DEFAULT_SHIPROCKET_CONFIG on the server so a never-saved channel shows sane values.
const DEFAULT_CONFIG: ShiprocketConfig = {
    pickupPincode: '',
    pickupLocationName: '',
    fxRate: 1,
    boxBrackets: [{ maxGrams: 2000, length: 20, breadth: 15, height: 10 }],
};

const withDefaults = (stored: Partial<ShiprocketConfig> | null | undefined): ShiprocketConfig => ({
    ...DEFAULT_CONFIG,
    ...(stored ?? {}),
});

export function ShiprocketSettingsPage() {
    const queryClient = useQueryClient();
    const { hasPermissions } = usePermissions();
    const canEdit = hasPermissions(['UpdateShiprocketSettings', 'SuperAdmin']);
    const [draft, setDraft] = useState<ShiprocketConfig | null>(null);

    const configQuery = useQuery({
        queryKey: ['shiprocket-config'],
        queryFn: () => api.query(shiprocketConfigDocument, { key: CONFIG_KEY }),
    });

    useEffect(() => {
        if (configQuery.data) {
            setDraft(withDefaults((configQuery.data as any).getSettingsStoreValue));
        }
    }, [configQuery.data]);

    const save = useMutation({
        mutationFn: (input: ShiprocketConfig) =>
            api.mutate(setShiprocketConfigDocument, { input: { key: CONFIG_KEY, value: input } }),
        onSuccess: (res: any) => {
            const result = res?.setSettingsStoreValue;
            if (result && result.result === false) {
                toast.error(result.error ?? 'Save failed');
                return;
            }
            toast.success('Shiprocket settings saved');
            queryClient.invalidateQueries({ queryKey: ['shiprocket-config'] });
        },
        onError: (e: any) => toast.error(e?.message ?? 'Save failed'),
    });

    if (configQuery.isLoading) {
        return <div className="p-4 text-muted-foreground">Loading…</div>;
    }
    if (configQuery.isError) {
        return (
            <div className="p-4 text-destructive">
                Failed to load Shiprocket settings: {(configQuery.error as any)?.message ?? 'unknown error'}.
                <div className="mt-1 text-sm text-muted-foreground">
                    If it says Forbidden, sign in as SuperAdmin or grant the ReadShiprocketSettings permission.
                </div>
            </div>
        );
    }
    if (!draft) {
        return <div className="p-4 text-muted-foreground">No settings available.</div>;
    }

    const isDirty =
        JSON.stringify(draft) !== JSON.stringify(withDefaults((configQuery.data as any)?.getSettingsStoreValue));

    const set = (patch: Partial<ShiprocketConfig>) => setDraft({ ...draft, ...patch });
    const updateBracket = (i: number, patch: Partial<BoxBracket>) =>
        setDraft({
            ...draft,
            boxBrackets: draft.boxBrackets.map((b, idx) => (idx === i ? { ...b, ...patch } : b)),
        });
    const addBracket = () =>
        setDraft({
            ...draft,
            boxBrackets: [...draft.boxBrackets, { maxGrams: 0, length: 0, breadth: 0, height: 0 }],
        });
    const removeBracket = (i: number) =>
        setDraft({ ...draft, boxBrackets: draft.boxBrackets.filter((_, idx) => idx !== i) });

    return (
        <div className="p-4">
            {canEdit && (
                <div className="mb-4 flex items-center justify-end gap-3">
                    <span className="text-xs text-muted-foreground">
                        {save.isPending ? 'Saving…' : isDirty ? 'Unsaved changes' : 'No changes'}
                    </span>
                    <Button onClick={() => save.mutate(draft)} disabled={save.isPending || !isDirty}>
                        {save.isPending ? 'Saving…' : 'Save'}
                    </Button>
                </div>
            )}

            {/* Account / global settings */}
            <Card className="mb-4">
                <CardContent className="space-y-4 pt-6">
                    <div className="font-medium">Shiprocket account</div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <Field label="Pickup pincode">
                            <Input
                                value={draft.pickupPincode}
                                disabled={!canEdit}
                                placeholder="625018"
                                onChange={e => set({ pickupPincode: e.target.value })}
                            />
                        </Field>
                        <Field label="Pickup location name">
                            <Input
                                value={draft.pickupLocationName}
                                disabled={!canEdit}
                                placeholder="warehouse"
                                onChange={e => set({ pickupLocationName: e.target.value })}
                            />
                        </Field>
                        <Field label="FX rate (INR per 1 USD)">
                            <Input
                                type="number"
                                value={draft.fxRate}
                                disabled={!canEdit}
                                placeholder="83"
                                onChange={e => set({ fxRate: Number(e.target.value) })}
                            />
                        </Field>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Pickup location name must match a pickup address nickname saved in Shiprocket
                        (used when creating orders at fulfillment). Purpose of shipment (2) and API
                        currency (USD) are fixed; the destination country comes from the order's
                        shipping address, so no allow-list is needed.
                    </p>
                </CardContent>
            </Card>

            {/* Editable weight → box dimension table */}
            <Card>
                <CardContent className="space-y-4 pt-6">
                    <div className="flex items-center justify-between">
                        <div className="font-medium">Box dimensions by weight</div>
                        {canEdit && (
                            <Button variant="secondary" type="button" onClick={addBracket}>
                                + Add row
                            </Button>
                        )}
                    </div>
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-muted-foreground">
                                <th className="py-1 font-normal">Up to weight (g)</th>
                                <th className="py-1 font-normal">Length (cm)</th>
                                <th className="py-1 font-normal">Breadth (cm)</th>
                                <th className="py-1 font-normal">Height (cm)</th>
                                <th className="py-1 font-normal" />
                            </tr>
                        </thead>
                        <tbody>
                            {draft.boxBrackets.map((b, i) => (
                                <tr key={i} className="border-t">
                                    <td className="py-1 pr-2">
                                        <Input
                                            type="number"
                                            value={b.maxGrams}
                                            disabled={!canEdit}
                                            onChange={e => updateBracket(i, { maxGrams: Number(e.target.value) })}
                                        />
                                    </td>
                                    <td className="py-1 pr-2">
                                        <Input
                                            type="number"
                                            value={b.length}
                                            disabled={!canEdit}
                                            onChange={e => updateBracket(i, { length: Number(e.target.value) })}
                                        />
                                    </td>
                                    <td className="py-1 pr-2">
                                        <Input
                                            type="number"
                                            value={b.breadth}
                                            disabled={!canEdit}
                                            onChange={e => updateBracket(i, { breadth: Number(e.target.value) })}
                                        />
                                    </td>
                                    <td className="py-1 pr-2">
                                        <Input
                                            type="number"
                                            value={b.height}
                                            disabled={!canEdit}
                                            onChange={e => updateBracket(i, { height: Number(e.target.value) })}
                                        />
                                    </td>
                                    <td className="py-1">
                                        {canEdit && draft.boxBrackets.length > 1 && (
                                            <Button variant="ghost" type="button" onClick={() => removeBracket(i)}>
                                                Remove
                                            </Button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <p className="text-xs text-muted-foreground">
                        A cart uses the first row whose “up to weight” it does not exceed (rows are sorted
                        ascending). Carts heavier than every row fall back to the largest one.
                    </p>
                </CardContent>
            </Card>
        </div>
    );
}

function Field(props: { label: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{props.label}</label>
            {props.children}
        </div>
    );
}

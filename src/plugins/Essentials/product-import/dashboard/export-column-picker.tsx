import { api, Button, Checkbox, Label, ScrollArea } from '@vendure/dashboard';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import React from 'react';
import { exportableFieldsDocument, ExportField } from './queries';

/** Trigger a browser download of a CSV string. Shared by every export entry point. */
export function downloadCsv(filename: string, content: string): void {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
}

export interface ColumnSelection {
    fields: ExportField[] | undefined;
    isLoading: boolean;
    selectedKeys: Set<string> | null;
    selectedCount: number;
    toggleKey: (key: string) => void;
    setAll: (checked: boolean) => void;
    /** Selected keys in canonical field order (what to send as `columns`). */
    orderedColumns: () => string[];
}

/**
 * Loads the exportable field list (only while `open`) and manages the checkbox
 * selection, seeded to "all checked". Shared by the Export button and the
 * "Export selected" bulk action so the picker behaves identically in both.
 */
export function useColumnSelection(open: boolean): ColumnSelection {
    const [selectedKeys, setSelectedKeys] = React.useState<Set<string> | null>(null);
    const { data, isLoading } = useQuery({
        queryKey: ['exportableFields'],
        queryFn: () => api.query(exportableFieldsDocument),
        enabled: open,
    });
    const fields = (data as { exportableFields: ExportField[] } | undefined)?.exportableFields;
    React.useEffect(() => {
        if (fields && selectedKeys === null) {
            setSelectedKeys(new Set(fields.map(field => field.key)));
        }
    }, [fields, selectedKeys]);
    function toggleKey(key: string): void {
        setSelectedKeys(prev => {
            const next = new Set(prev ?? []);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    }
    function setAll(checked: boolean): void {
        setSelectedKeys(checked && fields ? new Set(fields.map(field => field.key)) : new Set());
    }
    function orderedColumns(): string[] {
        return (fields ?? []).map(field => field.key).filter(key => selectedKeys?.has(key));
    }
    return {
        fields,
        isLoading,
        selectedKeys,
        selectedCount: selectedKeys?.size ?? 0,
        toggleKey,
        setAll,
        orderedColumns,
    };
}

/** The checkbox column list with Select all / Clear, driven by useColumnSelection. */
export function ColumnPicker({
    selection,
    disabled,
}: {
    selection: ColumnSelection;
    disabled?: boolean;
}): React.ReactElement {
    const { fields, isLoading, selectedKeys, selectedCount, toggleKey, setAll } = selection;
    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <Label>Columns ({selectedCount})</Label>
                <div className="flex items-center gap-2">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setAll(true)}
                        disabled={disabled || !fields}
                    >
                        Select all
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setAll(false)}
                        disabled={disabled || !fields}
                    >
                        Clear
                    </Button>
                </div>
            </div>
            {isLoading || !fields ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading columns…
                </div>
            ) : (
                <ScrollArea className="h-56 rounded-md border p-2">
                    <div className="space-y-1">
                        {fields.map(field => (
                            <label
                                key={field.key}
                                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted"
                            >
                                <Checkbox
                                    checked={selectedKeys?.has(field.key) ?? false}
                                    onCheckedChange={() => toggleKey(field.key)}
                                    disabled={disabled}
                                />
                                <span className="flex-1">{field.label}</span>
                                <span className="font-mono text-xs text-muted-foreground">{field.key}</span>
                            </label>
                        ))}
                    </div>
                </ScrollArea>
            )}
        </div>
    );
}

import {
    api,
    Button,
    BulkActionComponent,
    DataTableBulkActionItem,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    usePermissions,
} from '@vendure/dashboard';
import { Download, Loader2 } from 'lucide-react';
import React, { useState } from 'react';
import { toast } from 'sonner';
import { ColumnPicker, downloadCsv, useColumnSelection } from './export-column-picker';
import { exportProductsDocument } from './queries';

/**
 * "Export selected" bulk action for the product list. Unlike the Export button's
 * "current page" scope, this exports EXACTLY the rows the user ticked (by id), so
 * it always matches an active search / facet filter — the selection is explicit,
 * not a re-derived query.
 */
export const ExportSelectedBulkAction: BulkActionComponent<any> = ({ selection, table }) => {
    const { hasPermissions } = usePermissions();
    const canExport = hasPermissions(['CreateCatalog']) || hasPermissions(['UpdateCatalog']);
    const [open, setOpen] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const picker = useColumnSelection(open);

    async function handleExport() {
        if (!picker.fields || picker.selectedCount === 0) {
            return;
        }
        setIsExporting(true);
        try {
            const productIds = selection.map(row => row.id);
            const columns = picker.orderedColumns();
            const data = await api.query(exportProductsDocument, { productIds, columns });
            downloadCsv('products-export.csv', (data as { exportProducts: string }).exportProducts);
            setOpen(false);
            table?.resetRowSelection?.();
        } catch (err) {
            toast.error((err as Error)?.message ?? 'Export failed');
        } finally {
            setIsExporting(false);
        }
    }

    if (!canExport) {
        return null;
    }

    return (
        <>
            <DataTableBulkActionItem
                label="Export selected"
                icon={Download}
                onClick={() => setOpen(true)}
            />
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>Export {selection.length} selected</DialogTitle>
                        <DialogDescription>
                            Choose the columns to export for the products you selected.
                        </DialogDescription>
                    </DialogHeader>
                    <ColumnPicker selection={picker} disabled={isExporting} />
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setOpen(false)} disabled={isExporting}>
                            Close
                        </Button>
                        <Button onClick={handleExport} disabled={isExporting || picker.selectedCount === 0}>
                            {isExporting ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                                <Download className="mr-2 h-4 w-4" />
                            )}
                            Download CSV
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
};

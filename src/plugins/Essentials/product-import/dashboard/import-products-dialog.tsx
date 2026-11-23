import {
    api,
    Alert,
    AlertDescription,
    AlertTitle,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    Input,
    Label,
    usePermissions,
} from '@vendure/dashboard';
import { useMutation } from '@tanstack/react-query';
import {
    AlertCircle,
    CheckCircle2,
    Download,
    FileText,
    Loader2,
    Upload as UploadIcon,
} from 'lucide-react';
import React, { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ColumnPicker, downloadCsv, useColumnSelection } from './export-column-picker';
import {
    createProductsFromCsvDocument,
    exportProductsDocument,
    exportProductTemplateDocument,
    ImportInfo,
    updateProductsFromCsvDocument,
} from './queries';

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ExportProductsButton() {
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
            const columns = picker.orderedColumns();
            const data = await api.query(exportProductsDocument, { columns });
            downloadCsv('products-export.csv', (data as { exportProducts: string }).exportProducts);
            setOpen(false);
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
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger
                render={
                    <Button variant="outline">
                        <Download className="mr-2 h-4 w-4" />
                        Export
                    </Button>
                }
            />
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Export Products</DialogTitle>
                    <DialogDescription>
                        Download the active channel's catalog as CSV. Pick the columns you need,
                        edit the file, then use Import to update existing products or create new ones.
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
    );
}

export function ImportProductsButton() {
    const { hasPermissions } = usePermissions();
    const canCreate = hasPermissions(['CreateCatalog']);
    const canUpdate = hasPermissions(['UpdateCatalog']);
    const [open, setOpen] = useState(false);
    const [file, setFile] = useState<File | null>(null);
    const [rowCount, setRowCount] = useState<number | null>(null);
    const [result, setResult] = useState<ImportInfo | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    function handleResult(info: ImportInfo | null) {
        if (!info) {
            toast.error('Import returned no result');
            return;
        }
        setResult(info);
        const errorCount = info.errors?.length ?? 0;
        if (errorCount > 0) {
            toast.warning(`${info.imported} of ${info.processed} rows applied, ${errorCount} message(s)`);
        } else {
            toast.success(`${info.imported} product(s) applied`);
        }
    }

    const createMutation = useMutation({
        mutationFn: (csvFile: File) => api.mutate(createProductsFromCsvDocument, { csvFile }),
        onSuccess: data =>
            handleResult((data as { createProductsFromCsv: ImportInfo | null }).createProductsFromCsv),
        onError: (err: Error) => toast.error(err?.message ?? 'Create failed'),
    });

    const updateMutation = useMutation({
        mutationFn: (csvFile: File) => api.mutate(updateProductsFromCsvDocument, { csvFile }),
        onSuccess: data =>
            handleResult((data as { updateProductsFromCsv: ImportInfo | null }).updateProductsFromCsv),
        onError: (err: Error) => toast.error(err?.message ?? 'Update failed'),
    });

    async function handleDownloadTemplate() {
        try {
            const data = await api.query(exportProductTemplateDocument);
            downloadCsv(
                'vendure-product-import-template.csv',
                (data as { exportProductTemplate: string }).exportProductTemplate,
            );
        } catch (err) {
            toast.error((err as Error)?.message ?? 'Template download failed');
        }
    }

    async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
        const selected = event.target.files?.[0] ?? null;
        setResult(null);
        setFile(selected);
        if (!selected) {
            setRowCount(null);
            return;
        }
        const text = await selected.text();
        const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
        setRowCount(Math.max(0, lines.length - 1));
    }

    function reset() {
        setFile(null);
        setRowCount(null);
        setResult(null);
        if (inputRef.current) {
            inputRef.current.value = '';
        }
    }

    function handleOpenChange(next: boolean) {
        setOpen(next);
        if (!next) {
            reset();
        }
    }

    const isBusy = createMutation.isPending || updateMutation.isPending;

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogTrigger
                render={
                    <Button variant="outline">
                        <UploadIcon className="mr-2 h-4 w-4" />
                        Import
                    </Button>
                }
            />
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Import / Update Products</DialogTitle>
                    <DialogDescription>
                        Upload a CSV to update existing products (matched by SKU) or create new
                        ones. Applies to the active channel.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="flex items-center justify-between rounded-md border border-dashed p-3">
                        <div className="flex items-center gap-2 text-sm">
                            <FileText className="h-4 w-4 text-muted-foreground" />
                            <span>Need the format?</span>
                        </div>
                        <Button variant="ghost" size="sm" onClick={handleDownloadTemplate} disabled={isBusy}>
                            <Download className="mr-2 h-4 w-4" />
                            Download template
                        </Button>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="product-import-file">CSV file</Label>
                        <Input
                            id="product-import-file"
                            ref={inputRef}
                            type="file"
                            accept=".csv,text/csv"
                            onChange={handleFileChange}
                            disabled={isBusy}
                        />
                    </div>

                    {file && (
                        <div className="rounded-md bg-muted p-3 text-sm">
                            <div className="font-medium">Selected file</div>
                            <dl className="mt-2 space-y-1 text-muted-foreground">
                                <div className="flex justify-between gap-4">
                                    <dt>Name</dt>
                                    <dd className="truncate font-mono">{file.name}</dd>
                                </div>
                                <div className="flex justify-between gap-4">
                                    <dt>Size</dt>
                                    <dd>{formatBytes(file.size)}</dd>
                                </div>
                                <div className="flex justify-between gap-4">
                                    <dt>Data rows</dt>
                                    <dd>{rowCount ?? 0}</dd>
                                </div>
                            </dl>
                        </div>
                    )}

                    {result && (
                        <Alert variant={result.errors?.length ? 'destructive' : 'default'}>
                            {result.errors?.length ? (
                                <AlertCircle className="h-4 w-4" />
                            ) : (
                                <CheckCircle2 className="h-4 w-4" />
                            )}
                            <AlertTitle>
                                {result.imported} of {result.processed} processed
                            </AlertTitle>
                            {result.errors?.length ? (
                                <AlertDescription>
                                    <ul className="mt-1 max-h-40 list-disc space-y-1 overflow-auto pl-4 text-xs">
                                        {result.errors.map((error, index) => (
                                            <li key={index}>{error}</li>
                                        ))}
                                    </ul>
                                </AlertDescription>
                            ) : (
                                <AlertDescription>Completed successfully.</AlertDescription>
                            )}
                        </Alert>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isBusy}>
                        Close
                    </Button>
                    {canCreate && (
                        <Button
                            variant="outline"
                            onClick={() => file && createMutation.mutate(file)}
                            disabled={!file || isBusy}
                        >
                            {createMutation.isPending ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                                <UploadIcon className="mr-2 h-4 w-4" />
                            )}
                            Import new products
                        </Button>
                    )}
                    {canUpdate && (
                        <Button onClick={() => file && updateMutation.mutate(file)} disabled={!file || isBusy}>
                            {updateMutation.isPending ? (
                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                                <UploadIcon className="mr-2 h-4 w-4" />
                            )}
                            Update existing
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

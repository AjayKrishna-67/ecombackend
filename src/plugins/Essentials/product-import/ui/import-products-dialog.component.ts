import { ChangeDetectorRef, Component } from '@angular/core';
import { DataService, Dialog, NotificationService, SharedModule } from '@vendure/admin-ui/core';
import gql from 'graphql-tag';

const IMPORT_PRODUCTS = gql`
    mutation ImportProducts($csvFile: Upload!) {
        importProducts(csvFile: $csvFile) {
            imported
            processed
            errors
        }
    }
`;

const TEMPLATE_HEADER =
    'name,slug,description,assets,facets,optionGroups,optionValues,sku,price,taxCategory,stockOnHand,trackInventory,variantAssets,variantFacets,product:hsnCode,variant:shadowPrice';

const TEMPLATE_ROWS = [
    'Example T-Shirt,example-t-shirt,A comfortable cotton t-shirt,,category:Apparel,size,Small,TSHIRT-S,19.99,standard,100,true,,,1234,2499',
    ',,,,,,Medium,TSHIRT-M,19.99,standard,80,true,,,,2499',
];

interface ImportInfo {
    imported: number;
    processed: number;
    errors: string[] | null;
}

@Component({
    standalone: true,
    imports: [SharedModule],
    selector: 'product-import-dialog',
    template: `
        <ng-template vdrDialogTitle>Import Products</ng-template>

        <div class="import-content">
            <p class="hint">
                Upload a CSV file to bulk-create products. Use the template to ensure the correct
                column format.
            </p>

            <div class="template-row">
                <span>Need the format?</span>
                <button class="button-small" (click)="downloadTemplate()">
                    <clr-icon shape="download"></clr-icon>
                    Download template
                </button>
            </div>

            <div class="form-group">
                <label>CSV file</label>
                <input type="file" accept=".csv,text/csv" (change)="onFileChange($event)" [disabled]="importing" />
            </div>

            <div class="file-summary" *ngIf="file">
                <div class="summary-title">Selected file</div>
                <div class="summary-row"><span>Name</span><span class="mono">{{ file.name }}</span></div>
                <div class="summary-row"><span>Size</span><span>{{ formatBytes(file.size) }}</span></div>
                <div class="summary-row"><span>Data rows</span><span>{{ rowCount }}</span></div>
            </div>

            <div class="result" *ngIf="result" [class.has-errors]="(result.errors?.length ?? 0) > 0">
                <div class="result-title">
                    Imported {{ result.imported }} of {{ result.processed }} processed
                </div>
                <ul class="error-list" *ngIf="(result.errors?.length ?? 0) > 0">
                    <li *ngFor="let err of result.errors">{{ err }}</li>
                </ul>
                <div *ngIf="(result.errors?.length ?? 0) === 0">Import completed successfully.</div>
            </div>
        </div>

        <ng-template vdrDialogButtons>
            <button class="button secondary" (click)="resolveWith()" [disabled]="importing">Close</button>
            <button class="button primary" [disabled]="!file || importing" (click)="runImport()">
                <span *ngIf="!importing">Import</span>
                <span *ngIf="importing">Importing…</span>
            </button>
        </ng-template>
    `,
    styles: [
        `
            .import-content {
                padding: 0.5rem 0;
            }
            .hint {
                color: var(--color-text-300);
                font-size: 0.875rem;
                margin-bottom: 1rem;
            }
            .template-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 0.5rem;
                padding: 0.75rem;
                border: 1px dashed var(--color-component-border-300);
                border-radius: 6px;
                margin-bottom: 1rem;
                font-size: 0.875rem;
            }
            .button-small {
                display: inline-flex;
                align-items: center;
                gap: 0.375rem;
                background: none;
                border: 1px solid var(--color-component-border-300);
                border-radius: 4px;
                padding: 0.25rem 0.625rem;
                cursor: pointer;
                color: var(--color-text-100);
            }
            .button-small:hover {
                background: var(--color-component-bg-200);
            }
            .form-group {
                margin-bottom: 1rem;
            }
            .form-group label {
                display: block;
                font-size: 0.75rem;
                font-weight: 600;
                margin-bottom: 0.375rem;
                color: var(--color-text-200);
            }
            .file-summary {
                background: var(--color-component-bg-200);
                border-radius: 6px;
                padding: 0.75rem;
                font-size: 0.8125rem;
                margin-bottom: 1rem;
            }
            .summary-title {
                font-weight: 600;
                margin-bottom: 0.5rem;
            }
            .summary-row {
                display: flex;
                justify-content: space-between;
                gap: 1rem;
                color: var(--color-text-300);
                padding: 0.125rem 0;
            }
            .mono {
                font-family: monospace;
                word-break: break-all;
            }
            .result {
                border-radius: 6px;
                padding: 0.75rem;
                font-size: 0.8125rem;
                background: var(--color-success-100);
                border: 1px solid var(--color-success-300);
                color: var(--color-success-700);
            }
            .result.has-errors {
                background: var(--color-error-100);
                border-color: var(--color-error-300);
                color: var(--color-error-700);
            }
            .result-title {
                font-weight: 600;
                margin-bottom: 0.375rem;
            }
            .error-list {
                max-height: 10rem;
                overflow: auto;
                margin: 0;
                padding-left: 1.25rem;
                font-size: 0.75rem;
            }
        `,
    ],
})
export class ImportProductsDialogComponent implements Dialog<void> {
    resolveWith!: (result?: void) => void;
    file: File | null = null;
    rowCount = 0;
    importing = false;
    result: ImportInfo | null = null;

    constructor(
        private dataService: DataService,
        private notificationService: NotificationService,
        private cdRef: ChangeDetectorRef,
    ) {}

    async onFileChange(event: Event): Promise<void> {
        const input = event.target as HTMLInputElement;
        this.result = null;
        this.file = input.files?.[0] ?? null;
        if (!this.file) {
            this.rowCount = 0;
            return;
        }
        const text = await this.file.text();
        const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
        this.rowCount = Math.max(0, lines.length - 1);
        this.cdRef.markForCheck();
    }

    downloadTemplate(): void {
        const csv = [TEMPLATE_HEADER, ...TEMPLATE_ROWS].join('\n') + '\n';
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'vendure-product-import-template.csv';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
    }

    runImport(): void {
        if (!this.file) {
            return;
        }
        this.importing = true;
        this.dataService.mutate(IMPORT_PRODUCTS, { csvFile: this.file }).subscribe({
            next: (data: any) => {
                this.importing = false;
                const info = data.importProducts as ImportInfo;
                this.result = info;
                const errorCount = info?.errors?.length ?? 0;
                if (errorCount > 0) {
                    this.notificationService.warning(
                        `Imported ${info.imported} of ${info.processed} rows with ${errorCount} error(s)`,
                    );
                } else {
                    this.notificationService.success(`Imported ${info.imported} product(s)`);
                }
                this.cdRef.markForCheck();
            },
            error: (err: any) => {
                this.importing = false;
                this.notificationService.error(err?.message ?? 'Product import failed');
                this.cdRef.markForCheck();
            },
        });
    }

    formatBytes(bytes: number): string {
        if (bytes < 1024) {
            return `${bytes} B`;
        }
        if (bytes < 1024 * 1024) {
            return `${(bytes / 1024).toFixed(1)} KB`;
        }
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
}

import { graphql } from '@vendure/dashboard';

export const exportProductsDocument = graphql(`
    query ExportProducts($columns: [String!], $productIds: [ID!]) {
        exportProducts(columns: $columns, productIds: $productIds)
    }
`);

export const exportableFieldsDocument = graphql(`
    query ExportableFields {
        exportableFields {
            key
            label
            level
            type
        }
    }
`);

export interface ExportField {
    key: string;
    label: string;
    level: string;
    type: string;
}

export const exportProductTemplateDocument = graphql(`
    query ExportProductTemplate {
        exportProductTemplate
    }
`);

export const createProductsFromCsvDocument = graphql(`
    mutation CreateProductsFromCsv($csvFile: Upload!) {
        createProductsFromCsv(csvFile: $csvFile) {
            imported
            processed
            errors
        }
    }
`);

export const updateProductsFromCsvDocument = graphql(`
    mutation UpdateProductsFromCsv($csvFile: Upload!) {
        updateProductsFromCsv(csvFile: $csvFile) {
            imported
            processed
            errors
        }
    }
`);

export interface ImportInfo {
    imported: number;
    processed: number;
    errors: string[] | null;
}

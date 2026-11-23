import gql from 'graphql-tag';

export const adminApiExtensions = gql`
    type CsvImportResult {
        imported: Int!
        processed: Int!
        errors: [String!]!
    }

    "One column offered in the export field picker (base column or custom field)."
    type ExportField {
        key: String!
        label: String!
        level: String!
        type: String!
    }

    extend type Query {
        "Export products/variants in the active channel as a CSV string. Pass productIds to export exactly those products; otherwise the whole catalog is exported. Pass columns to export only those keys (omit = all)."
        exportProducts(columns: [String!], productIds: [ID!]): String!
        "CSV template (header + sample rows) for new-product import"
        exportProductTemplate: String!
        "The columns available to export (base columns + scalar custom fields), for the field picker."
        exportableFields: [ExportField!]!
    }

    extend type Mutation {
        "Create new products from a CSV (delegates to core import, gated on CreateCatalog)"
        createProductsFromCsv(csvFile: Upload!): CsvImportResult!
        "Update existing variants (matched by SKU) from a CSV (gated on UpdateCatalog)"
        updateProductsFromCsv(csvFile: Upload!): CsvImportResult!
    }
`;

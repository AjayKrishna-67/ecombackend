import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import gql from 'graphql-tag';

import { BulkSyncController } from './bulk-sync.controller';
import { BulkSyncResolver } from './bulk-sync.resolver';
import { BulkSyncService } from './bulk-sync.service';
import { bulkSyncPermission } from './permissions';

const adminApiExtensions = gql`
    input BulkSyncRowInput {
        sku: String!
        price: Float!
        stock: Int!
        shadowPrice: Int
        hsnCode: String
    }

    input BulkSyncInput {
        city: String!
        rows: [BulkSyncRowInput!]!
    }

    type BulkSyncVariantChange {
        sku: String!
        productName: String!
        oldPrice: Float
        newPrice: Float!
        oldStock: Int!
        newStock: Int!
        oldShadowPrice: Int!
        newShadowPrice: Int!
        oldHsnCode: String
        newHsnCode: String
        priceChanged: Boolean!
        stockChanged: Boolean!
        shadowChanged: Boolean!
        hsnChanged: Boolean!
    }

    type BulkSyncResult {
        city: String!
        channelCode: String!
        matched: Int!
        updated: Int!
        skipped: Int!
        notFound: Int!
        errors: [String!]!
        changes: [BulkSyncVariantChange!]!
    }

    type BulkSyncExportRow {
        sku: String!
        productName: String!
        price: Float!
        stock: Int!
        shadowPrice: Int!
        hsnCode: String
    }

    type BulkSyncCityExport {
        city: String!
        rows: [BulkSyncExportRow!]!
    }

    type BulkSyncExportResult {
        city: String
        rows: [BulkSyncExportRow!]
        byCity: [BulkSyncCityExport!]
    }

    extend type Mutation {
        bulkSyncProducts(input: BulkSyncInput!): BulkSyncResult!
    }

    extend type Query {
        bulkSyncExport(city: String): BulkSyncExportResult!
    }
`;

@VendurePlugin({
    imports: [PluginCommonModule],
    controllers: [BulkSyncController],
    providers: [BulkSyncService],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [BulkSyncResolver],
    },
    compatibility: '^3.1.0',
    configuration: config => {
        config.authOptions.customPermissions.push(bulkSyncPermission);
        return config;
    },
})
export class BulkSyncPlugin {}

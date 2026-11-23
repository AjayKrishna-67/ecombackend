import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import * as path from 'path';
import gql from 'graphql-tag';
import { StockManagerResolver } from './api/stock-manager.resolver';

// Define the API Schema
const schemaExtension = gql`
  extend type Mutation {
    deleteStockLevel(productVariantId: ID!, stockLocationId: ID!): Boolean!
  }
`;

@VendurePlugin({
  imports: [PluginCommonModule],
  adminApiExtensions: {
    schema: schemaExtension,
    resolvers: [StockManagerResolver],
  },
  dashboard: './dashboard/index.tsx',
  compatibility: '^3.6.3',
})
export class StockLevelDeleterPlugin {
  static UiExtensions: AdminUiExtension = {
    id: 'stock-manager-ui',
    extensionPath: path.join(__dirname, 'ui'),
    providers: ['providers.ts'],
  };
}


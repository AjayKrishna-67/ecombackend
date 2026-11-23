import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import path from 'path';
import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { gql } from 'graphql-tag';
import { StockMonitoringResolver } from './api/stock-monitoring.resolver';

/**
 * Configuration options for the StockMonitoringPlugin.
 */
export interface StockMonitoringPluginOptions {
  /**
   * Widget will show productvariants with a stocklevel below 'threshold'
   */
  threshold: number;
  /**
   * Required permission to view the stock monitoring widget.
   * Default: 'ReadCatalog'
   * Set to null to allow all authenticated users
   */
  requiredPermission?: string | null;
}

@VendurePlugin({
  imports: [PluginCommonModule],
  adminApiExtensions: {
    schema: gql`
      extend type Query {
        productVariantsWithLowStock(
          skip: Int
          take: Int
        ): ProductVariantList!
      }
    `,
    resolvers: [StockMonitoringResolver],
  },
  dashboard: './dashboard/index.tsx',
  compatibility: '^3.6.3',
})
export class StockMonitoringPlugin {
  static ui: AdminUiExtension = {
    extensionPath: path.join(__dirname, 'ui'),
    providers: ['providers.ts'],
  };
  static threshold = 10;
  static requiredPermission: string | null = 'ReadCatalog';

  static init(
    options: StockMonitoringPluginOptions
  ): typeof StockMonitoringPlugin {
    this.threshold = options.threshold;
    this.requiredPermission = options.requiredPermission ?? 'ReadCatalog';
    return StockMonitoringPlugin;
  }
}
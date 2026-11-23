import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { Allow, Ctx, Permission, RequestContext } from '@vendure/core';
import { Readable } from 'stream';
import { buildTemplateCsv } from '../services/product-csv.helpers';
import { ExportField, ImportInfo, ProductCsvService } from '../services/product-csv.service';

type UploadArg = Promise<{
    createReadStream: () => Readable;
    filename: string;
    mimetype: string;
    encoding: string;
}>;

async function readUpload(upload: UploadArg): Promise<string> {
    const { createReadStream } = await upload;
    const chunks: Buffer[] = [];
    for await (const chunk of createReadStream()) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
}

@Resolver()
export class ProductCsvResolver {
    constructor(private productCsvService: ProductCsvService) {}

    @Query()
    @Allow(Permission.CreateCatalog, Permission.UpdateCatalog)
    exportProducts(
        @Ctx() ctx: RequestContext,
        @Args() args: { columns?: string[]; productIds?: string[] },
    ): Promise<string> {
        return this.productCsvService.exportCsv(ctx, {
            columns: args.columns,
            productIds: args.productIds,
        });
    }

    @Query()
    @Allow(Permission.CreateCatalog, Permission.UpdateCatalog)
    exportableFields(@Ctx() ctx: RequestContext): ExportField[] {
        return this.productCsvService.getExportableFields(ctx);
    }

    @Query()
    @Allow(Permission.CreateCatalog, Permission.UpdateCatalog)
    exportProductTemplate(): string {
        return buildTemplateCsv();
    }

    @Mutation()
    @Allow(Permission.CreateCatalog)
    async createProductsFromCsv(
        @Ctx() ctx: RequestContext,
        @Args() args: { csvFile: UploadArg },
    ): Promise<ImportInfo> {
        const csv = await readUpload(args.csvFile);
        return this.productCsvService.createFromCsv(ctx, csv);
    }

    @Mutation()
    @Allow(Permission.UpdateCatalog)
    async updateProductsFromCsv(
        @Ctx() ctx: RequestContext,
        @Args() args: { csvFile: UploadArg },
    ): Promise<ImportInfo> {
        const csv = await readUpload(args.csvFile);
        return this.productCsvService.updateFromCsv(ctx, csv);
    }
}

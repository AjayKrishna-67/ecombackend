import {
    Body,
    Controller,
    Get,
    HttpStatus,
    Post,
    Query,
    Req,
    Res,
} from '@nestjs/common';
import {
    RequestContextService,
    SessionService,
    extractSessionToken,
    ConfigService,
} from '@vendure/core';
import { Request, Response } from 'express';

import { BulkSyncService, SyncRow } from './bulk-sync.service';

interface BulkUpdateBody {
    city: string;
    rows: SyncRow[];
}

@Controller('admin-api/bulk-sync')
export class BulkSyncController {
    constructor(
        private readonly bulkSyncService: BulkSyncService,
        private readonly requestContextService: RequestContextService,
        private readonly sessionService: SessionService,
        private readonly configService: ConfigService,
    ) {}

    // Resolves the session from the request cookie/bearer token,
    // then builds a RequestContext with that session passed in.
    // fromRequest() alone does NOT read the session — it must be supplied.
    private async getCtx(req: Request) {
        const tokenMethod = this.configService.authOptions.tokenMethod;
        const apiKeyHeaderKey = this.configService.authOptions.apiKeyHeaderKey ?? 'vendure-api-key';
        const result = extractSessionToken(req, tokenMethod, apiKeyHeaderKey);
        const session = result ? await this.sessionService.getSessionFromToken(result.token) : undefined;
        return this.requestContextService.fromRequest(req, undefined, undefined, session ?? undefined);
    }

    @Post('products')
    async bulkUpdate(
        @Req() req: Request,
        @Res() res: Response,
        @Body() body: BulkUpdateBody,
    ) {
        const ctx = await this.getCtx(req);

        if (!ctx.activeUserId) {
            return res.status(HttpStatus.UNAUTHORIZED).json({ error: 'Unauthorized' });
        }
        if (!this.bulkSyncService.hasPermission(ctx)) {
            return res.status(HttpStatus.FORBIDDEN).json({ error: 'Forbidden: missing BulkSyncProducts permission' });
        }

        const { city, rows } = body ?? {};
        if (!city || !Array.isArray(rows)) {
            return res
                .status(HttpStatus.BAD_REQUEST)
                .json({ error: 'Request body must include "city" (string) and "rows" (array)' });
        }

        const channel = await this.bulkSyncService.resolveChannel(ctx, city);
        if (!channel) {
            return res.status(HttpStatus.NOT_FOUND).json({ error: `Channel not found for city: ${city}` });
        }

        const result = await this.bulkSyncService.bulkUpdate(ctx, city, rows);
        return res.status(HttpStatus.OK).json(result);
    }

    @Get('products')
    async exportProducts(
        @Req() req: Request,
        @Res() res: Response,
        @Query('city') city?: string,
    ) {
        const ctx = await this.getCtx(req);

        if (!ctx.activeUserId) {
            return res.status(HttpStatus.UNAUTHORIZED).json({ error: 'Unauthorized' });
        }
        if (!this.bulkSyncService.hasPermission(ctx)) {
            return res.status(HttpStatus.FORBIDDEN).json({ error: 'Forbidden: missing BulkSyncProducts permission' });
        }

        if (city) {
            const channel = await this.bulkSyncService.resolveChannel(ctx, city);
            if (!channel) {
                return res.status(HttpStatus.NOT_FOUND).json({ error: `Channel not found for city: ${city}` });
            }
            const rows = await this.bulkSyncService.exportByCity(ctx, city);
            return res.status(HttpStatus.OK).json(rows);
        }

        const grouped = await this.bulkSyncService.exportAllCities(ctx);
        return res.status(HttpStatus.OK).json(grouped);
    }
}

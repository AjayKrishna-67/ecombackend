import {
    Body,
    Controller,
    ForbiddenException,
    Get,
    Headers,
    HttpCode,
    Post,
    Query,
    Req,
    UnauthorizedException,
} from '@nestjs/common';
import { Logger } from '@vendure/core';

import { loggerCtx } from '../constants';
import { WhatsappService } from '../services/whatsapp.service';
import { WhatsappWebhookPayload } from '../types';

@Controller('whatsapp')
export class WhatsappController {
    constructor(private whatsappService: WhatsappService) {}

    /** Meta calls this once when you click "Verify and save" in the webhook settings. */
    @Get('webhook')
    verify(
        @Query('hub.mode') mode: string,
        @Query('hub.verify_token') token: string,
        @Query('hub.challenge') challenge: string,
    ) {
        if (mode === 'subscribe' && this.whatsappService.isValidVerifyToken(token)) {
            return challenge;
        }
        throw new ForbiddenException();
    }

    /** Every incoming message lands here. Reply 200 fast and do the work in the background. */
    @Post('webhook')
    @HttpCode(200)
    receive(
        // rawBody is stashed by the beforeListen json({ verify }) middleware in vendure-config.ts
        @Req() req: { rawBody?: Buffer },
        @Headers('x-hub-signature-256') signature: string | undefined,
        @Body() payload: WhatsappWebhookPayload,
    ) {
        if (!this.whatsappService.isValidSignature(req.rawBody, signature)) {
            throw new UnauthorizedException('Invalid signature');
        }
        this.whatsappService
            .handleIncoming(payload)
            .catch(err => Logger.error(err?.message ?? String(err), loggerCtx));
        return 'ok';
    }
}

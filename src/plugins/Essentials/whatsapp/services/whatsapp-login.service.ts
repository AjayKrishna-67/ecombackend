import { Injectable } from '@nestjs/common';
import { Channel, RequestContext, TransactionalConnection } from '@vendure/core';
import { createHash, randomBytes } from 'crypto';
import { LessThan, MoreThan } from 'typeorm';

import { WhatsappLoginToken } from '../entities/whatsapp-login-token.entity';

const LINK_TTL_MS = 30 * 60_000;
const SECRET_BYTES = 32;
// 32 bytes base64url-encoded is always 43 characters (no padding).
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface VerifiedWhatsappLogin {
    phoneNumber: string;
    firstName: string;
}

/**
 * Issues and redeems the single-use secrets inside WhatsApp login links.
 * Meta's signed webhook is the proof that the customer owns the phone, so the
 * link needs no OTP; the secret is the only credential.
 */
@Injectable()
export class WhatsappLoginService {
    constructor(private readonly connection: TransactionalConnection) {}

    /**
     * Creates a login for a phone WhatsApp has already proven and returns the raw
     * secret for the link. Expired rows are purged here, so the table stays small
     * without a scheduled task (and without needing the worker).
     */
    async issueVerified(login: VerifiedWhatsappLogin): Promise<string> {
        const repository = this.connection.getRepository(undefined, WhatsappLoginToken);
        await repository.delete({ expiresAt: LessThan(new Date()) });
        const secret = randomBytes(SECRET_BYTES).toString('base64url');
        await repository.save(
            new WhatsappLoginToken({
                secretHash: hashSecret(secret),
                phoneNumber: login.phoneNumber,
                firstName: login.firstName,
                expiresAt: new Date(Date.now() + LINK_TTL_MS),
            }),
        );
        return secret;
    }

    /**
     * Redeems a link secret: returns the phone and name once, then null forever.
     * The DELETE is the lock — of two concurrent taps, only the one whose delete
     * removes the row wins (same compare-and-delete as PhoneOtpService.verifyOtp).
     */
    async consume(ctx: RequestContext, secret: string): Promise<VerifiedWhatsappLogin | null> {
        if (!SECRET_PATTERN.test(secret)) {
            return null;
        }
        const repository = this.connection.getRepository(ctx, WhatsappLoginToken);
        const secretHash = hashSecret(secret);
        const row = await repository.findOne({ where: { secretHash } });
        if (!row) {
            return null;
        }
        const result = await repository.delete({ secretHash, expiresAt: MoreThan(new Date()) });
        if ((result.affected ?? 0) !== 1) {
            return null;
        }
        return { phoneNumber: row.phoneNumber, firstName: row.firstName };
    }

    /**
     * Token of the channel a login link should open, or null if no channel has
     * that code. Read per call (not cached) so a token changed in the admin UI
     * is picked up at once; this runs once per city tap, not per request.
     */
    async findChannelToken(code: string): Promise<string | null> {
        const channel = await this.connection
            .getRepository(undefined, Channel)
            .findOne({ where: { code }, select: ['id', 'token'] });
        return channel?.token ?? null;
    }
}

function hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
}

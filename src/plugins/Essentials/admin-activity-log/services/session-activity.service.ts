import { Injectable } from '@nestjs/common';
import { Logger, RequestContext, Session, TransactionalConnection } from '@vendure/core';
import { ADMIN_ACTIVITY_LOG_CONFIG } from '../constants';

const LOGGER_CTX = 'AdminActivityLog';

const { LAST_SEEN_THROTTLE_MS, MAX_STRING_LENGTH } = ADMIN_ACTIVITY_LOG_CONFIG;

/**
 * Records device identity and liveness on the Session row.
 *
 * Populating this at login is tempting and wrong: `AuthService` publishes
 * `LoginEvent` before the new session is attached to the RequestContext, so
 * there is no reliable way to know which session row was just created without
 * racing on "most recent session for this user" — which mis-assigns when someone
 * logs in on two devices at once. Touching on the first authenticated *request*
 * instead has the session in hand and no race.
 *
 * `lastSeenAt` matters more than it looks. `sessionDuration` is unset in this
 * project so Vendure's `'1y'` default applies, which makes a raw active-session
 * count mean "every browser that logged in this year". `lastSeenAt` is what
 * turns that pile into an answer to "who is actually working right now".
 */
@Injectable()
export class SessionActivityService {
    private lastWriteBySession = new Map<string, number>();

    constructor(private readonly connection: TransactionalConnection) {}

    /**
     * Records that the session behind this request is alive, and fills in device
     * identity the first time it is seen.
     *
     * Throttled and fire-and-forget by contract: this runs on every admin API
     * request, so an unthrottled write here would put the database back under the
     * load that took this server down during the bulk price sync.
     */
    touch(ctx: RequestContext): void {
        const sessionId = ctx.session?.id;
        if (sessionId === undefined || ctx.activeUserId === undefined) {
            return;
        }
        const key = String(sessionId);
        const now = Date.now();
        const lastWrite = this.lastWriteBySession.get(key) ?? 0;
        if (now - lastWrite < LAST_SEEN_THROTTLE_MS) {
            return;
        }
        this.lastWriteBySession.set(key, now);
        void this.persist(sessionId, ctx, new Date(now));
    }

    /** Forgets throttle state for a session, so a re-login re-stamps the device. */
    forget(sessionId: string | number): void {
        this.lastWriteBySession.delete(String(sessionId));
    }

    private async persist(sessionId: string | number, ctx: RequestContext, seenAt: Date): Promise<void> {
        try {
            await this.connection.rawConnection.getRepository(Session).update(sessionId, {
                customFields: {
                    userAgent: this.readUserAgent(ctx),
                    ipAddress: this.readIpAddress(ctx),
                    lastSeenAt: seenAt,
                },
            } as never);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`Failed to stamp session ${String(sessionId)}: ${message}`, LOGGER_CTX);
        }
    }

    private readUserAgent(ctx: RequestContext): string | null {
        const raw = ctx.req?.headers?.['user-agent'];
        const value = Array.isArray(raw) ? raw[0] : raw;
        return value ? value.slice(0, MAX_STRING_LENGTH) : null;
    }

    private readIpAddress(ctx: RequestContext): string | null {
        const req = ctx.req;
        if (!req) {
            return null;
        }
        const forwarded = req.headers?.['x-forwarded-for'];
        const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
        return (first?.trim() || req.ip) ?? null;
    }
}

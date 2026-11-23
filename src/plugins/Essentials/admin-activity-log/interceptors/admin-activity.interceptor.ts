import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { internal_getRequestContext, Logger, RequestContext } from '@vendure/core';
import { GraphQLResolveInfo } from 'graphql';
import { Observable, tap } from 'rxjs';
import { ADMIN_ACTIVITY_LOG_CONFIG } from '../constants';
import { ActivityLogWriterService, PendingActivityRow } from '../services/activity-log-writer.service';
import { extractTarget } from '../services/extract-target';
import { sanitizePayload } from '../services/sanitize-payload';
import { SessionActivityService } from '../services/session-activity.service';

const LOGGER_CTX = 'AdminActivityLog';

const { IGNORED_OPERATIONS, SENSITIVE_READ_OPERATIONS } = ADMIN_ACTIVITY_LOG_CONFIG;

type BaseRow = Omit<PendingActivityRow, 'outcome' | 'errorMessage' | 'durationMs'>;

/**
 * Captures every administrator-initiated mutation on the Admin API.
 *
 * This sits ABOVE the fork between Vendure core services and this project's ~40
 * custom plugins, which is why it is the interceptor and not an EventBus
 * subscriber. Core services publish `VendureEntityEvent`s; the custom plugins
 * (price-matrix, location-stock, postal-code, cancel-order, settings-store
 * writes) publish nothing at all, so an event-based audit would miss them
 * silently. The interceptor also observes FAILED mutations, which no event can.
 *
 * Volume control happens in three early exits, in order of how much they
 * discard: non-GraphQL requests, non-root and non-mutation fields, then any
 * request whose API type is not `admin` — which removes all storefront traffic.
 */
@Injectable()
export class AdminActivityInterceptor implements NestInterceptor {
    constructor(
        private readonly writer: ActivityLogWriterService,
        private readonly sessionActivity: SessionActivityService,
    ) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        if (context.getType<GqlContextType>() !== 'graphql') {
            return next.handle();
        }
        const gqlContext = GqlExecutionContext.create(context);
        const info = gqlContext.getInfo<GraphQLResolveInfo>();
        if (info?.path?.prev !== undefined) {
            return next.handle();
        }
        const ctx = this.readRequestContext(gqlContext, context);
        if (!ctx || ctx.apiType !== 'admin') {
            return next.handle();
        }
        this.sessionActivity.touch(ctx);
        if (!this.shouldCapture(info)) {
            return next.handle();
        }
        return this.captureWith(ctx, info, gqlContext.getArgs(), next);
    }

    private captureWith(
        ctx: RequestContext,
        info: GraphQLResolveInfo,
        args: unknown,
        next: CallHandler,
    ): Observable<unknown> {
        const startedAt = Date.now();
        const base = this.buildBaseRow(ctx, info, args);
        return next.handle().pipe(
            tap({
                next: value => this.record(base, startedAt, this.readErrorResult(value)),
                error: (err: unknown) => this.record(base, startedAt, this.readThrownError(err)),
            }),
        );
    }

    /**
     * Decides whether a root admin field is worth a row. Mutations are captured
     * unless explicitly ignored; queries only when they appear in the sensitive
     * read list, because reads are roughly 20x the volume of writes for a
     * fraction of the forensic value.
     *
     * Root-ness is checked by the caller via `info.path.prev`: a GraphQL
     * interceptor fires for every resolved field including nested field
     * resolvers, so without that check one mutation returning a Product with 40
     * variants would write dozens of duplicate rows.
     */
    private shouldCapture(info: GraphQLResolveInfo): boolean {
        const operation = info?.operation?.operation;
        const fieldName = info?.fieldName;
        if (!operation || !fieldName) {
            return false;
        }
        if (operation === 'mutation') {
            return !IGNORED_OPERATIONS.includes(fieldName as never);
        }
        return operation === 'query' && SENSITIVE_READ_OPERATIONS.includes(fieldName as never);
    }

    private readRequestContext(
        gqlContext: GqlExecutionContext,
        context: ExecutionContext,
    ): RequestContext | undefined {
        try {
            const req = gqlContext.getContext()?.req;
            return req ? internal_getRequestContext(req, context) : undefined;
        } catch {
            return undefined;
        }
    }

    private buildBaseRow(ctx: RequestContext, info: GraphQLResolveInfo, args: unknown): BaseRow {
        const target = extractTarget(info.fieldName, args);
        return {
            operationName: info.fieldName,
            entityType: target.entityType,
            entityId: target.entityId,
            targetCount: target.targetCount,
            payload: sanitizePayload(args),
            userId: ctx.activeUserId ?? null,
            sessionId: this.readSessionId(ctx),
            channelId: ctx.channelId ?? null,
            ipAddress: this.readIpAddress(ctx),
            isAuthEvent: false,
        };
    }

    /**
     * Records the Session's primary key so a working day can be grouped per
     * device AND joined back to the Session row, which is where the device
     * fingerprint (userAgent, ipAddress, lastSeenAt) lives.
     *
     * This deliberately stores the id, not the token. The token is a live
     * credential and must never be persisted. An earlier version stored a
     * truncated SHA-256 of the token instead, which was safe but joinless: the
     * hash matched nothing on the Session row, so device details could not be
     * resolved for any log row. The id is not a credential, so there is nothing
     * to protect and everything to gain.
     *
     * Rows written before this change carry a hash and simply resolve no device.
     */
    private readSessionId(ctx: RequestContext): string | null {
        const sessionId = ctx.session?.id;
        return sessionId === undefined || sessionId === null ? null : String(sessionId);
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

    /**
     * Vendure returns expected failures as ErrorResult union members rather than
     * throwing, so a mutation that "succeeded" at the transport layer may still
     * have failed in business terms. Both shapes must land in the log as ERROR.
     */
    private readErrorResult(value: unknown): string | null {
        if (!value || typeof value !== 'object') {
            return null;
        }
        const candidate = value as { errorCode?: unknown; message?: unknown };
        if (typeof candidate.errorCode !== 'string') {
            return null;
        }
        return typeof candidate.message === 'string'
            ? `${candidate.errorCode}: ${candidate.message}`
            : candidate.errorCode;
    }

    private readThrownError(err: unknown): string {
        if (err instanceof Error) {
            return `${err.name}: ${err.message}`;
        }
        return String(err);
    }

    private record(base: BaseRow, startedAt: number, errorMessage: string | null): void {
        try {
            this.writer.enqueue({
                ...base,
                outcome: errorMessage === null ? 'SUCCESS' : 'ERROR',
                errorMessage,
                durationMs: Date.now() - startedAt,
            });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.error(`Failed to enqueue audit row for ${base.operationName}: ${message}`, LOGGER_CTX);
        }
    }
}

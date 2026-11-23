import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import {
    AttemptedLoginEvent,
    EventBus,
    LoginEvent,
    LogoutEvent,
    RequestContext,
} from '@vendure/core';
import { Subscription } from 'rxjs';
import { ActivityLogWriterService, PendingActivityRow } from '../services/activity-log-writer.service';
import { SessionActivityService } from '../services/session-activity.service';

/** How long to wait for a LoginEvent before ruling an attempt failed. */
const FAILED_LOGIN_GRACE_MS = 5_000;

interface PendingAttempt {
    identifier: string;
    strategy: string;
    ipAddress: string | null;
    userAgent: string | null;
    timer: NodeJS.Timeout;
}

/**
 * Writes authentication events into the same log as data mutations, so a working
 * day reads as one timeline rather than two systems the reader has to join by
 * hand.
 *
 * Failed logins are the reason this exists. Vendure publishes
 * `AttemptedLoginEvent` for every login attempt and `LoginEvent` only on success,
 * so a failure is an attempt with no success behind it. Nothing in this project
 * records that today, which means brute-force attempts against the admin API are
 * currently invisible.
 *
 * Note on logout: `AuthService.destroyAuthenticatedSession` deletes ALL sessions
 * for the user, not just the one that logged out, so a single LOGOUT row marks
 * the end of every one of that administrator's device sessions.
 */
@Injectable()
export class AuthActivitySubscriber implements OnApplicationBootstrap, OnApplicationShutdown {
    private subscriptions: Subscription[] = [];
    private pendingAttempts = new Map<RequestContext, PendingAttempt>();

    constructor(
        private readonly eventBus: EventBus,
        private readonly writer: ActivityLogWriterService,
        private readonly sessionActivity: SessionActivityService,
    ) {}

    /** @internal */
    onApplicationBootstrap(): void {
        this.subscriptions.push(
            this.eventBus.ofType(AttemptedLoginEvent).subscribe(event => this.onAttempt(event)),
            this.eventBus.ofType(LoginEvent).subscribe(event => this.onLogin(event)),
            this.eventBus.ofType(LogoutEvent).subscribe(event => this.onLogout(event)),
        );
    }

    /** @internal */
    onApplicationShutdown(): void {
        for (const subscription of this.subscriptions) {
            subscription.unsubscribe();
        }
        for (const attempt of this.pendingAttempts.values()) {
            clearTimeout(attempt.timer);
        }
        this.pendingAttempts.clear();
    }

    private onAttempt(event: AttemptedLoginEvent): void {
        if (event.ctx.apiType !== 'admin') {
            return;
        }
        const timer = setTimeout(() => this.recordFailure(event.ctx), FAILED_LOGIN_GRACE_MS);
        timer.unref();
        this.pendingAttempts.set(event.ctx, {
            identifier: event.identifier ?? 'unknown',
            strategy: event.strategy,
            ipAddress: this.readIpAddress(event.ctx),
            userAgent: this.readUserAgent(event.ctx),
            timer,
        });
    }

    private onLogin(event: LoginEvent): void {
        if (event.ctx.apiType !== 'admin') {
            return;
        }
        const attempt = this.clearAttempt(event.ctx);
        this.writer.enqueue(
            this.buildAuthRow(event.ctx, 'LOGIN', 'SUCCESS', {
                identifier: attempt?.identifier ?? event.user.identifier,
                strategy: attempt?.strategy ?? 'native',
                userAgent: attempt?.userAgent ?? this.readUserAgent(event.ctx),
            }),
        );
    }

    private onLogout(event: LogoutEvent): void {
        if (event.ctx.apiType !== 'admin') {
            return;
        }
        const sessionId = event.ctx.session?.id;
        if (sessionId !== undefined) {
            this.sessionActivity.forget(sessionId);
        }
        this.writer.enqueue(
            this.buildAuthRow(event.ctx, 'LOGOUT', 'SUCCESS', {
                note: 'Vendure ends every session for this user, not only this device',
            }),
        );
    }

    private recordFailure(ctx: RequestContext): void {
        const attempt = this.pendingAttempts.get(ctx);
        if (!attempt) {
            return;
        }
        this.pendingAttempts.delete(ctx);
        this.writer.enqueue({
            operationName: 'LOGIN_FAILED',
            entityType: 'Administrator',
            entityId: null,
            targetCount: 1,
            payload: { identifier: attempt.identifier, strategy: attempt.strategy, userAgent: attempt.userAgent },
            outcome: 'ERROR',
            errorMessage: `Failed login for identifier "${attempt.identifier}"`,
            userId: null,
            sessionId: null,
            channelId: ctx.channelId ?? null,
            ipAddress: attempt.ipAddress,
            durationMs: 0,
            isAuthEvent: true,
            fallbackAdminName: attempt.identifier,
        });
    }

    private clearAttempt(ctx: RequestContext): PendingAttempt | undefined {
        const attempt = this.pendingAttempts.get(ctx);
        if (attempt) {
            clearTimeout(attempt.timer);
            this.pendingAttempts.delete(ctx);
        }
        return attempt;
    }

    private buildAuthRow(
        ctx: RequestContext,
        operationName: string,
        outcome: 'SUCCESS' | 'ERROR',
        payload: Record<string, unknown>,
    ): PendingActivityRow {
        return {
            operationName,
            entityType: 'Administrator',
            entityId: null,
            targetCount: 1,
            payload,
            outcome,
            errorMessage: null,
            userId: ctx.activeUserId ?? null,
            sessionId: null,
            channelId: ctx.channelId ?? null,
            ipAddress: this.readIpAddress(ctx),
            durationMs: 0,
            isAuthEvent: true,
        };
    }

    private readUserAgent(ctx: RequestContext): string | null {
        const raw = ctx.req?.headers?.['user-agent'];
        const value = Array.isArray(raw) ? raw[0] : raw;
        return value ?? null;
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

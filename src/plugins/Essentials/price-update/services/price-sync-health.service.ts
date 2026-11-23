import { Injectable } from '@nestjs/common';
import { Logger, TransactionalConnection } from '@vendure/core';

const loggerCtx = 'PriceSyncHealth';

export interface HealthThresholds {
    probeThresholdMs: number;
    minFreePoolPct: number;
}

export interface HealthDecision {
    healthy: boolean;
    reason: string;
    probeMs?: number;
    freePoolPct?: number;
}

/** Env-driven thresholds so ops can tune the gate without a redeploy. */
export function readThresholds(): HealthThresholds {
    return {
        probeThresholdMs: Number(process.env.PRICE_SYNC_MAX_PROBE_MS ?? '150'),
        minFreePoolPct: Number(process.env.PRICE_SYNC_MIN_FREE_POOL_PCT ?? '40'),
    };
}

/** Manual kill switch — flip PRICE_SYNC_PAUSED=true to halt draining instantly. */
export function isPaused(): boolean {
    return String(process.env.PRICE_SYNC_PAUSED ?? '').toLowerCase() === 'true';
}

/**
 * Pure: decide healthy/unhealthy from measured signals. Conservative — any red
 * signal blocks the drain. Extracted so the decision is unit-testable without a DB.
 */
export function decideHealth(
    input: { paused: boolean; probeMs: number; freePoolPct: number | null },
    thresholds: HealthThresholds,
): HealthDecision {
    if (input.paused) {
        return { healthy: false, reason: 'paused (PRICE_SYNC_PAUSED=true)' };
    }
    if (input.probeMs > thresholds.probeThresholdMs) {
        return {
            healthy: false,
            reason: `db slow: probe ${input.probeMs}ms > ${thresholds.probeThresholdMs}ms`,
            probeMs: input.probeMs,
        };
    }
    if (input.freePoolPct !== null && input.freePoolPct < thresholds.minFreePoolPct) {
        return {
            healthy: false,
            reason: `pool tight: ${input.freePoolPct}% free < ${thresholds.minFreePoolPct}%`,
            freePoolPct: input.freePoolPct,
        };
    }
    return {
        healthy: true,
        reason: 'ok',
        probeMs: input.probeMs,
        freePoolPct: input.freePoolPct ?? undefined,
    };
}

/**
 * Decides whether the background price-sync drain may run right now. The gate
 * that makes the drain unable to repeat the Sunday outage: if the DB is slow or
 * the connection pool is tight, draining is skipped this tick and retried later.
 */
@Injectable()
export class PriceSyncHealthService {
    constructor(private connection: TransactionalConnection) {}

    async check(): Promise<HealthDecision> {
        const thresholds = readThresholds();
        const paused = isPaused();
        const probeMs = await this.measureProbeMs();
        const freePoolPct = this.readFreePoolPct();
        const decision = decideHealth({ paused, probeMs, freePoolPct }, thresholds);
        if (!decision.healthy) {
            Logger.info(`Drain skipped — ${decision.reason}`, loggerCtx);
        }
        return decision;
    }

    /** Round-trip time of a trivial query — rises when the DB/pool is stressed. */
    private async measureProbeMs(): Promise<number> {
        const start = Date.now();
        try {
            await this.connection.rawConnection.query('SELECT 1');
        } catch {
            return Number.MAX_SAFE_INTEGER; // DB error => maximally unhealthy
        }
        return Date.now() - start;
    }

    /** mysql2 pool free %, best-effort; null if driver internals aren't as expected. */
    private readFreePoolPct(): number | null {
        try {
            const pool: any = (this.connection.rawConnection.driver as any)?.pool;
            if (!pool) return null;
            const all = pool._allConnections?.length ?? pool.pool?._allConnections?.length;
            const free = pool._freeConnections?.length ?? pool.pool?._freeConnections?.length;
            if (typeof all !== 'number' || typeof free !== 'number' || all === 0) {
                return null;
            }
            return Math.round((free / all) * 100);
        } catch {
            return null;
        }
    }
}

import { Injectable } from '@nestjs/common';
import { ID, Logger, TransactionalConnection } from '@vendure/core';

export const loggerCtx = 'AssetChannelSync';

/** Sentinel meaning "every row of this entity type". Only `syncAll` uses it. */
export const ALL_IDS = 'all' as const;

/**
 * An id list, or ALL_IDS. `undefined` and `[]` both mean "skip this entity
 * type" -- see `toScope` for why an empty array must never widen to everything.
 */
export type IdScope = readonly ID[] | typeof ALL_IDS | undefined;

/** Scope for a single reconcile pass. Omit a key to skip that entity type. */
export interface SyncTargets {
    readonly productIds?: IdScope;
    readonly variantIds?: IdScope;
    readonly collectionIds?: IdScope;
}

/**
 * Keeps `asset_channels_channel` in step with the channels of the Products,
 * ProductVariants and Collections that reference each Asset.
 *
 * WHY THIS EXISTS
 * ---------------
 * `Asset` is ChannelAware; `featuredAssetId` is a plain foreign key that is not.
 * So in a channel an Asset was never assigned to, the Admin API answers two
 * contradictory things about the same relation:
 *
 *     productVariant(id: 14) { featuredAsset { id } }  ->  { id: "4588" }
 *     productVariant(id: 14) { assets { id } }         ->  []
 *
 * The dashboard detail page builds `assetIds: entity.assets.map(a => a.id)` from
 * the filtered list, so it submits `[]`, and `AssetService.updateEntityAssets`
 * reads an empty array as "remove them all" -- indistinguishable from the
 * merchant genuinely clearing the assets. Every asset link for that entity is
 * deleted and `featuredAssetId` goes NULL, with a success toast. The thumbnail
 * looks correct right up to the save because `EntityAssets` renders it from the
 * `featuredAsset` prop and never consults `assets`.
 *
 * Migration 1785995000000 healed the existing rows. This service stops the drift
 * coming back: assigning a Product to a new Channel does NOT carry its Assets
 * across, and neither does attaching an Asset that lives in only one Channel.
 *
 * WHY SET-BASED SQL RATHER THAN ENTITY LOADS
 * ------------------------------------------
 * A bulk channel assignment or a CSV import fires these events hundreds of times.
 * Loading each entity with its assets and channels would be several queries per
 * event; this is one INSERT..SELECT per reference path regardless of how many
 * ids are in scope, and the `NOT EXISTS` guard makes it a no-op once things are
 * in step -- which is the normal case.
 *
 * Deliberately additive: it only ever GRANTS channel visibility for an asset a
 * channel's own content already displays. It never removes an assignment, so it
 * cannot be the cause of the very data loss it prevents.
 */
@Injectable()
export class AssetChannelSyncService {
    constructor(private readonly connection: TransactionalConnection) {}

    /**
     * Reconciles the given entities. Safe to call repeatedly -- it converges and
     * then does nothing.
     *
     * Uses `rawConnection`, NOT the request's transactional manager: these events
     * are emitted after their transaction commits, so the ctx's manager may
     * already be finished. This work is idempotent and independent, so running
     * it outside the original transaction is correct rather than merely
     * convenient.
     */
    async syncTargets(targets: SyncTargets): Promise<number> {
        const statements = this.buildStatements(targets);
        if (statements.length === 0) {
            return 0;
        }
        let inserted = 0;
        for (const { label, sql, params } of statements) {
            try {
                const result = await this.connection.rawConnection.query(sql, params);
                inserted += this.affectedRows(result);
            } catch (err: any) {
                // Never let a sync failure break the operation that triggered it.
                // The worst case is the drift we started with, which the audit
                // query in the plugin README will surface.
                Logger.error(
                    `Failed to sync asset channels for ${label}: ${err?.message ?? String(err)}`,
                    loggerCtx,
                );
            }
        }
        if (inserted > 0) {
            Logger.verbose(`Assigned ${inserted} asset/channel link(s)`, loggerCtx);
        }
        return inserted;
    }

    /** Reconciles the whole catalogue. For a manual repair after bulk imports. */
    async syncAll(): Promise<number> {
        return this.syncTargets({
            productIds: ALL_IDS,
            variantIds: ALL_IDS,
            collectionIds: ALL_IDS,
        });
    }

    // ── internals ──────────────────────────────────────────────────────────

    private buildStatements(
        targets: SyncTargets,
    ): Array<{ label: string; sql: string; params: unknown[] }> {
        const out: Array<{ label: string; sql: string; params: unknown[] }> = [];

        // `buildSelect` is only invoked once the scope is known to be non-null,
        // so no statement can ever be generated without its WHERE clause -- an
        // unscoped INSERT here would silently widen a one-entity sync into a
        // full-catalogue scan on every save.
        const add = (label: string, scope: Scope | null, buildSelect: (scope: Scope) => string) => {
            if (scope == null) {
                return;
            }
            out.push({
                label,
                sql: `INSERT IGNORE INTO \`asset_channels_channel\` (assetId, channelId)
                      SELECT src.assetId, src.channelId FROM (${buildSelect(scope)}) src
                      WHERE NOT EXISTS (
                        SELECT 1 FROM \`asset_channels_channel\` ac
                        WHERE ac.assetId = src.assetId AND ac.channelId = src.channelId
                      )`,
                params: scope.params,
            });
        };

        const productScope = toScope(targets.productIds);
        add('product assets', productScope, s =>
            `SELECT DISTINCT pa.assetId AS assetId, pc.channelId AS channelId
             FROM \`product_asset\` pa
             JOIN \`product_channels_channel\` pc ON pc.productId = pa.productId
             WHERE ${s.clause('pa.productId')}`,
        );
        add('product featured', productScope, s =>
            `SELECT DISTINCT p.featuredAssetId AS assetId, pc.channelId AS channelId
             FROM \`product\` p
             JOIN \`product_channels_channel\` pc ON pc.productId = p.id
             WHERE p.featuredAssetId IS NOT NULL AND p.deletedAt IS NULL
               AND ${s.clause('p.id')}`,
        );

        const variantScope = toScope(targets.variantIds);
        add('variant assets', variantScope, s =>
            `SELECT DISTINCT pva.assetId AS assetId, vc.channelId AS channelId
             FROM \`product_variant_asset\` pva
             JOIN \`product_variant_channels_channel\` vc
               ON vc.productVariantId = pva.productVariantId
             WHERE ${s.clause('pva.productVariantId')}`,
        );
        add('variant featured', variantScope, s =>
            `SELECT DISTINCT v.featuredAssetId AS assetId, vc.channelId AS channelId
             FROM \`product_variant\` v
             JOIN \`product_variant_channels_channel\` vc ON vc.productVariantId = v.id
             WHERE v.featuredAssetId IS NOT NULL AND v.deletedAt IS NULL
               AND ${s.clause('v.id')}`,
        );

        const collectionScope = toScope(targets.collectionIds);
        add('collection assets', collectionScope, s =>
            `SELECT DISTINCT ca.assetId AS assetId, cc.channelId AS channelId
             FROM \`collection_asset\` ca
             JOIN \`collection_channels_channel\` cc ON cc.collectionId = ca.collectionId
             WHERE ${s.clause('ca.collectionId')}`,
        );
        add('collection featured', collectionScope, s =>
            `SELECT DISTINCT c.featuredAssetId AS assetId, cc.channelId AS channelId
             FROM \`collection\` c
             JOIN \`collection_channels_channel\` cc ON cc.collectionId = c.id
             WHERE c.featuredAssetId IS NOT NULL
               AND ${s.clause('c.id')}`,
        );

        return out;
    }

    /** mysql2 returns an OkPacket; other drivers may not. Degrade to 0. */
    private affectedRows(result: unknown): number {
        const affected = (result as any)?.affectedRows;
        return typeof affected === 'number' ? affected : 0;
    }
}

interface Scope {
    clause: (column: string) => string;
    params: unknown[];
}

/**
 * Turns an id list into a WHERE fragment plus its parameters, or null when there
 * is nothing to do. Returning null for an EMPTY array matters: `IN ()` is a
 * syntax error in MySQL, and an unscoped statement would silently widen a
 * single-entity sync into a full-catalogue scan.
 */
function toScope(ids: IdScope): Scope | null {
    if (ids === ALL_IDS) {
        return { clause: () => '1=1', params: [] };
    }
    if (ids == null || ids.length === 0) {
        return null;
    }
    const unique = [...new Set(ids.map(id => String(id)))];
    return {
        clause: (column: string) => `${column} IN (${unique.map(() => '?').join(',')})`,
        params: unique,
    };
}

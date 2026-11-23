/**
 * One-time repair: assign every live ProductOptionGroup (and, through the same core
 * service, its options) to each channel that one of its products is already in.
 *
 * Why it is needed: core's variant-level `assignProductVariantsToChannel` copies only the
 * product and the variant into the channel, while the product-level
 * `assignProductsToChannel` also copies the product's option groups and options. Products
 * moved into a channel through the variant route therefore carry option groups that the
 * channel cannot see. `ProductOption.group` is resolved *in the current channel* and is
 * non-nullable, so any query that selects it (the React dashboard's variant detail does,
 * the Angular admin does not) fails in that channel with
 * "Cannot return null for non-nullable field ProductOption.group".
 *
 * Uses ProductOptionGroupService.assignProductOptionGroupsToChannel, the service behind the
 * admin mutation of the same name, so nothing is written by hand. Safe to re-run: channels
 * already assigned are skipped by core.
 *
 * Dry run (prints the plan, writes nothing):
 *   bunx ts-node src/scripts/repair-option-group-channels.ts
 * Apply:
 *   bunx ts-node src/scripts/repair-option-group-channels.ts --apply
 */
import {
    Logger,
    ProductOptionGroupService,
    RequestContextService,
    TransactionalConnection,
    User,
    bootstrapWorker,
} from '@vendure/core';

import { config } from '../vendure-config';

const ctxName = 'RepairOptionGroupChannels';

type MissingPair = {
    groupId: number;
    groupCode: string;
    channelId: number;
    channelCode: string;
    products: number;
};

// A (group, channel) pair is missing when a live product that uses the group is in the
// channel but the group itself is not.
const MISSING_PAIRS_SQL = `
    SELECT pg.productOptionGroupId AS groupId,
           pog.code                AS groupCode,
           pc.channelId            AS channelId,
           ch.code                 AS channelCode,
           COUNT(DISTINCT pg.productId) AS products
    FROM product_option_groups_product_option_group pg
    JOIN product_option_group pog
      ON pog.id = pg.productOptionGroupId AND pog.deletedAt IS NULL
    JOIN product_channels_channel pc ON pc.productId = pg.productId
    JOIN channel ch ON ch.id = pc.channelId
    LEFT JOIN product_option_group_channels_channel pogc
      ON pogc.productOptionGroupId = pg.productOptionGroupId AND pogc.channelId = pc.channelId
    WHERE pogc.channelId IS NULL
    GROUP BY pg.productOptionGroupId, pog.code, pc.channelId, ch.code
    ORDER BY pc.channelId, pg.productOptionGroupId
`;

async function run(): Promise<void> {
    const apply = process.argv.includes('--apply');

    // A standalone process must never re-run schema sync against the live database.
    (config.dbConnectionOptions as any).synchronize = false;
    const worker = await bootstrapWorker(config);
    const app = worker.app;

    const connection = app.get(TransactionalConnection);
    const requestContextService = app.get(RequestContextService);
    const optionGroupService = app.get(ProductOptionGroupService);

    // The service checks the active user's catalog permissions on the target channel, so
    // the context has to carry the superadmin rather than be an anonymous admin context.
    const superadminIdentifier = config.authOptions.superadminCredentials?.identifier;
    const superadmin = await connection.rawConnection.getRepository(User).findOne({
        where: { identifier: superadminIdentifier },
        relations: ['roles', 'roles.channels'],
    });
    if (!superadmin) {
        throw new Error(`superadmin user "${superadminIdentifier}" not found`);
    }
    const ctx = await requestContextService.create({ apiType: 'admin', user: superadmin });

    const findMissing = async (): Promise<MissingPair[]> => {
        const rows: any[] = await connection.rawConnection.query(MISSING_PAIRS_SQL);
        return rows.map(r => ({
            groupId: Number(r.groupId),
            groupCode: String(r.groupCode),
            channelId: Number(r.channelId),
            channelCode: String(r.channelCode),
            products: Number(r.products),
        }));
    };

    const missing = await findMissing();
    if (missing.length === 0) {
        Logger.info('Nothing to repair: every option group is in every channel its products are in.', ctxName);
        await app.close();
        process.exit(0);
    }

    const byChannel = new Map<number, { code: string; groupIds: number[]; products: number }>();
    for (const pair of missing) {
        const entry = byChannel.get(pair.channelId) ?? { code: pair.channelCode, groupIds: [], products: 0 };
        entry.groupIds.push(pair.groupId);
        entry.products += pair.products;
        byChannel.set(pair.channelId, entry);
    }

    Logger.info(
        `${missing.length} missing (group, channel) pair(s) across ${byChannel.size} channel(s)` +
            (apply ? ' — applying' : ' — DRY RUN, pass --apply to write'),
        ctxName,
    );
    for (const [channelId, entry] of byChannel) {
        Logger.info(
            `  channel ${channelId} ${entry.code}: groups [${entry.groupIds.join(', ')}] (${entry.products} product link(s))`,
            ctxName,
        );
    }

    let failed = 0;
    if (apply) {
        for (const [channelId, entry] of byChannel) {
            try {
                const result = await optionGroupService.assignProductOptionGroupsToChannel(ctx, {
                    channelId,
                    productOptionGroupIds: entry.groupIds,
                });
                Logger.info(
                    `  channel ${channelId} ${entry.code}: assigned ${entry.groupIds.length} group(s), service returned ${result.length}`,
                    ctxName,
                );
            } catch (err: any) {
                failed += 1;
                Logger.error(`  channel ${channelId} ${entry.code}: FAILED: ${err.message}`, ctxName);
            }
        }
        const remaining = await findMissing();
        Logger.info(`Verification: ${remaining.length} missing pair(s) remain.`, ctxName);
        if (remaining.length > 0) {
            failed += 1;
        }
    }

    await app.close();
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    Logger.error(String(err?.stack ?? err), ctxName);
    process.exit(1);
});

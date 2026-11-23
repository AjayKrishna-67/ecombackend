import { mergeConfig } from '@vendure/core';
import {
    createTestEnvironment,
    registerInitializer,
    SqljsInitializer,
    testConfig,
} from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScheduledAvailabilityPlugin } from '../scheduled-availability.plugin';
import { initialData } from './fixtures/initial-data';

/**
 * End-to-end coverage for scheduled availability: a real Vendure server, a real
 * database, the real Admin API and the real applier.
 *
 * What this buys over the unit tests. `compute-occurrences.spec.ts` proves the
 * maths; nothing there proves the resolver is wired to the service, that the
 * entities persist, that the DISABLE action reaches ProductService, or that the
 * product's `enabled` column actually changes. Every one of those has failed in
 * a plugin at some point while the pure functions stayed green.
 */

// Resolved from the working directory rather than from `import.meta.url`: the
// project's build tsconfig targets CommonJS, where `import.meta` is a hard
// compile error even though vitest's esbuild transform accepts it. Vitest always
// runs with the project root as cwd, so this points at the same folder without
// splitting the file's module semantics from the rest of src/.
const dataDir = path.join(
    process.cwd(),
    'src/plugins/Essentials/scheduled-availability/e2e/__data__',
);

// sql.js keeps the database in memory and snapshots it to this directory. The
// first run pays the population cost; later runs load the snapshot, which is why
// e2e suites get faster after the first execution.
registerInitializer('sqljs', new SqljsInitializer(dataDir));

const { server, adminClient } = createTestEnvironment(
    mergeConfig(testConfig, {
        plugins: [ScheduledAvailabilityPlugin],
        // Not the default 3050: a dev server or another suite may already hold it.
        apiOptions: { port: 3055 },
    }),
);

const CREATE_PRODUCT = gql`
    mutation CreateTestProduct($input: CreateProductInput!) {
        createProduct(input: $input) {
            id
            enabled
        }
    }
`;

const GET_PRODUCT = gql`
    query GetTestProduct($id: ID!) {
        product(id: $id) {
            id
            enabled
        }
    }
`;

const GET_ACTIVE_CHANNEL = gql`
    query GetActiveChannel {
        activeChannel {
            id
        }
    }
`;

const PREVIEW_SCHEDULE = gql`
    query PreviewSchedule($input: CreateAvailabilityScheduleInput!, $count: Int) {
        previewAvailabilitySchedule(input: $input, count: $count) {
            dueAt
            action
        }
    }
`;

const CREATE_SCHEDULE = gql`
    mutation CreateSchedule($input: CreateAvailabilityScheduleInput!) {
        createAvailabilitySchedule(input: $input) {
            id
            mode
            isEnabled
            targetName
        }
    }
`;

const RUN_SCHEDULE_NOW = gql`
    mutation RunScheduleNow($id: ID!) {
        runAvailabilityScheduleNow(id: $id)
    }
`;

const GET_SCHEDULE_RUNS = gql`
    query GetScheduleRuns($scheduleId: ID!) {
        availabilityScheduleRuns(scheduleId: $scheduleId) {
            totalItems
            items {
                status
                action
                executedAt
            }
        }
    }
`;

const GET_SCHEDULES = gql`
    query GetSchedules {
        availabilitySchedules {
            totalItems
            items {
                id
                mode
                targetType
            }
        }
    }
`;

describe('ScheduledAvailabilityPlugin (e2e)', () => {
    let channelId: string;
    let productId: string;

    beforeAll(async () => {
        await server.init({ initialData, customerCount: 0 });
        await adminClient.asSuperAdmin();

        const channelResult = await adminClient.query(GET_ACTIVE_CHANNEL);
        channelId = channelResult.activeChannel.id;

        const productResult = await adminClient.query(CREATE_PRODUCT, {
            input: {
                translations: [
                    {
                        languageCode: 'en',
                        name: 'Pomegranate',
                        slug: 'pomegranate',
                        description: 'Test target for scheduled availability',
                    },
                ],
            },
        });
        productId = productResult.createProduct.id;
        expect(productResult.createProduct.enabled).toBe(true);
    }, 180_000);

    afterAll(async () => {
        await server.destroy();
    });

    describe('preview', () => {
        it('converts a Friday-midnight India-time rule into the correct UTC instants', async () => {
            const actualResult = await adminClient.query(PREVIEW_SCHEDULE, {
                input: {
                    targetType: 'Product',
                    targetId: productId,
                    channelId,
                    mode: 'RECURRING',
                    disableCron: '0 0 * * 5',
                    enableCron: '0 0 * * 6',
                    timezone: 'Asia/Kolkata',
                },
                count: 4,
            });

            const actualOccurrences = actualResult.previewAvailabilitySchedule;
            expect(actualOccurrences).toHaveLength(4);

            // Asserted as properties rather than as fixed ISO strings: preview
            // counts forward from "now", so literal dates would rot tomorrow.
            // The properties are the actual contract and hold on any day.
            for (const occurrence of actualOccurrences) {
                const dueAt = new Date(occurrence.dueAt);
                // Midnight IST is 18:30 the previous UTC day, every time.
                expect(dueAt.getUTCHours()).toBe(18);
                expect(dueAt.getUTCMinutes()).toBe(30);
                // 4 = Thursday, 5 = Friday. Local Friday midnight is UTC Thursday
                // evening; local Saturday midnight is UTC Friday evening. If this
                // ever reads 5 and 6, the timezone stopped being applied.
                expect(dueAt.getUTCDay()).toBe(occurrence.action === 'DISABLE' ? 4 : 5);
            }
        });
    });

    describe('one-off rules', () => {
        it('disables the product when a due DISABLE rule is run', async () => {
            // One minute in the past: `decideRunDisposition` skips anything not yet
            // due, and anything older than STALE_RUN_GRACE_MINUTES (120).
            const inputRunAt = new Date(Date.now() - 60_000).toISOString();

            const createResult = await adminClient.query(CREATE_SCHEDULE, {
                input: {
                    targetType: 'Product',
                    targetId: productId,
                    channelId,
                    mode: 'ONE_OFF',
                    runAt: inputRunAt,
                    action: 'DISABLE',
                    timezone: 'Asia/Kolkata',
                    label: 'e2e disable',
                },
            });
            const scheduleId = createResult.createAvailabilitySchedule.id;
            expect(createResult.createAvailabilitySchedule.targetName).toBe('Pomegranate');

            await adminClient.query(RUN_SCHEDULE_NOW, { id: scheduleId });

            const actualProduct = await adminClient.query(GET_PRODUCT, { id: productId });
            expect(actualProduct.product.enabled).toBe(false);

            const actualRuns = await adminClient.query(GET_SCHEDULE_RUNS, { scheduleId });
            expect(actualRuns.availabilityScheduleRuns.totalItems).toBe(1);
            expect(actualRuns.availabilityScheduleRuns.items[0].status).toBe('DONE');
            expect(actualRuns.availabilityScheduleRuns.items[0].action).toBe('DISABLE');
            expect(actualRuns.availabilityScheduleRuns.items[0].executedAt).not.toBeNull();
        });

        it('re-enables the product when a due ENABLE rule is run', async () => {
            const inputRunAt = new Date(Date.now() - 60_000).toISOString();

            const createResult = await adminClient.query(CREATE_SCHEDULE, {
                input: {
                    targetType: 'Product',
                    targetId: productId,
                    channelId,
                    mode: 'ONE_OFF',
                    runAt: inputRunAt,
                    action: 'ENABLE',
                    timezone: 'Asia/Kolkata',
                    label: 'e2e enable',
                },
            });

            await adminClient.query(RUN_SCHEDULE_NOW, {
                id: createResult.createAvailabilitySchedule.id,
            });

            const actualProduct = await adminClient.query(GET_PRODUCT, { id: productId });
            expect(actualProduct.product.enabled).toBe(true);
        });

        it('records a NOOP when the target is already in the wanted state', async () => {
            // The product is enabled after the previous test, so a second ENABLE
            // has nothing to write. NOOP rather than DONE keeps "we changed
            // something" distinguishable from "we agreed with reality".
            const createResult = await adminClient.query(CREATE_SCHEDULE, {
                input: {
                    targetType: 'Product',
                    targetId: productId,
                    channelId,
                    mode: 'ONE_OFF',
                    runAt: new Date(Date.now() - 60_000).toISOString(),
                    action: 'ENABLE',
                    timezone: 'Asia/Kolkata',
                    label: 'e2e noop',
                },
            });
            const scheduleId = createResult.createAvailabilitySchedule.id;

            await adminClient.query(RUN_SCHEDULE_NOW, { id: scheduleId });

            const actualRuns = await adminClient.query(GET_SCHEDULE_RUNS, { scheduleId });
            expect(actualRuns.availabilityScheduleRuns.items[0].status).toBe('NOOP');
        });
    });

    describe('channel scoping', () => {
        it('lists the rules created in the active channel', async () => {
            const actualResult = await adminClient.query(GET_SCHEDULES);

            expect(actualResult.availabilitySchedules.totalItems).toBeGreaterThan(0);
            expect(
                actualResult.availabilitySchedules.items.every(
                    (item: { targetType: string }) => item.targetType === 'Product',
                ),
            ).toBe(true);
        });
    });
});

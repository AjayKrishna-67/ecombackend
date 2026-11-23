import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Permission, RequestContext } from '@vendure/core';
import { CustomerAnalyticsAdminResolver } from './customer-analytics-admin.resolver';
import { customerAnalyticsPermission, updateCustomerAnalyticsPermission } from '../permissions';

// Metadata key @vendure/core's @Allow writes to (SetMetadata('__permissions__', perms)).
// Read it straight off the method to assert the permission gate without a live server.
const PERMISSIONS_METADATA_KEY = '__permissions__';

function permissionsFor(method: (...args: never[]) => unknown): unknown[] {
    return (Reflect.getMetadata(PERMISSIONS_METADATA_KEY, method) as unknown[]) ?? [];
}

// SettingsStore keys (namespace.field) the resolver writes to. Kept in the test as plain
// strings so a rename of the private constants surfaces here as a failing expectation.
const SETTING_ACTIVE = 'customerAnalytics.activeWithinDays';
const SETTING_AT_RISK = 'customerAnalytics.atRiskUntilDays';

function createResolver() {
    const settingsStore = { set: vi.fn().mockResolvedValue({ result: true }), get: vi.fn() };
    const segmentService = {} as never;
    const customerGroupService = {} as never;
    const resolver = new CustomerAnalyticsAdminResolver(
        segmentService,
        settingsStore as never,
        customerGroupService,
    );
    return { resolver, settingsStore };
}

const ctx = {} as RequestContext;

// ctx for save tests: defaultGroupName reads only ctx.channel.code.
const saveCtx = { channel: { code: 'madurai' } } as unknown as RequestContext;

const GROUP_PAGE_SIZE = 1000;
const GROUP_WRITE_CHUNK = 500;

function genIds(count: number, prefix: string): string[] {
    return Array.from({ length: count }, (_unused, i) => `${prefix}${i}`);
}

// Builds a resolver whose CustomerGroupService + CustomerSegmentService are fully mocked.
// settingsStore.get returns undefined so readThresholds falls back to valid defaults (30/60).
function createSaveResolver(members: string[]) {
    const settingsStore = { set: vi.fn(), get: vi.fn().mockResolvedValue(undefined) };
    const segmentService = { listCustomerIds: vi.fn() };
    const memberRows = members.map(id => ({ id }));
    const customerGroupService = {
        findAll: vi.fn(),
        create: vi.fn(),
        findOne: vi.fn().mockResolvedValue({ id: 'g1', name: 'madurai Churn' }),
        getGroupCustomers: vi
            .fn()
            .mockImplementation((_c: unknown, _id: unknown, opts: { take: number; skip: number }) =>
                Promise.resolve({
                    items: memberRows.slice(opts.skip, opts.skip + opts.take),
                    totalItems: memberRows.length,
                }),
            ),
        addCustomersToGroup: vi.fn().mockResolvedValue({}),
        removeCustomersFromGroup: vi.fn().mockResolvedValue({}),
    };
    const resolver = new CustomerAnalyticsAdminResolver(
        segmentService as never,
        settingsStore as never,
        customerGroupService as never,
    );
    return { resolver, segmentService, customerGroupService };
}

describe('CustomerAnalyticsAdminResolver.saveCustomerSegmentAsGroup', () => {
    it('uses a stable, date-free default name so re-saves target one group', async () => {
        const { resolver, segmentService, customerGroupService } = createSaveResolver([]);
        segmentService.listCustomerIds.mockResolvedValue(['1', '2', '3']);
        customerGroupService.findAll.mockResolvedValue({ items: [], totalItems: 0 });
        customerGroupService.create.mockResolvedValue({ id: 'g1', name: 'madurai Churn' });
        await resolver.saveCustomerSegmentAsGroup(saveCtx, { state: 'CHURN' });
        const createdName = customerGroupService.create.mock.calls[0][1].name;
        expect(createdName).toBe('madurai Churn');
        expect(createdName).not.toMatch(/\d{4}-\d{2}-\d{2}/);
        expect(customerGroupService.create).toHaveBeenCalledWith(saveCtx, {
            name: 'madurai Churn',
            customerIds: [],
        });
        expect(customerGroupService.addCustomersToGroup).toHaveBeenCalledWith(saveCtx, {
            customerGroupId: 'g1',
            customerIds: ['1', '2', '3'],
        });
        expect(customerGroupService.removeCustomersFromGroup).not.toHaveBeenCalled();
    });

    it('syncs an existing group without ever exceeding the list-query limit', async () => {
        const oldIds = genIds(1500, 'old');
        const { resolver, segmentService, customerGroupService } = createSaveResolver(oldIds);
        segmentService.listCustomerIds.mockResolvedValue(['new1']);
        customerGroupService.findAll.mockResolvedValue({
            items: [{ id: 'g1', name: 'madurai Churn' }],
            totalItems: 1,
        });
        await resolver.saveCustomerSegmentAsGroup(saveCtx, { state: 'CHURN' });
        expect(customerGroupService.create).not.toHaveBeenCalled();
        const takes = customerGroupService.getGroupCustomers.mock.calls.map(
            (call: unknown[]) => (call[2] as { take: number }).take,
        );
        expect(takes.every((take: number) => take <= GROUP_PAGE_SIZE)).toBe(true);
        const removed = customerGroupService.removeCustomersFromGroup.mock.calls.flatMap(
            (call: unknown[]) => (call[1] as { customerIds: string[] }).customerIds,
        );
        expect(removed).toEqual(oldIds);
        expect(customerGroupService.addCustomersToGroup).toHaveBeenCalledWith(saveCtx, {
            customerGroupId: 'g1',
            customerIds: ['new1'],
        });
    });

    it('writes membership in bounded batches for a large segment', async () => {
        const { resolver, segmentService, customerGroupService } = createSaveResolver([]);
        segmentService.listCustomerIds.mockResolvedValue(genIds(1200, 'c'));
        customerGroupService.findAll.mockResolvedValue({ items: [], totalItems: 0 });
        customerGroupService.create.mockResolvedValue({ id: 'g1', name: 'madurai Churn' });
        await resolver.saveCustomerSegmentAsGroup(saveCtx, { state: 'CHURN' });
        const addBatches = customerGroupService.addCustomersToGroup.mock.calls.map(
            (call: unknown[]) => (call[1] as { customerIds: string[] }).customerIds.length,
        );
        expect(addBatches).toEqual([500, 500, 200]);
        expect(addBatches.every((size: number) => size <= GROUP_WRITE_CHUNK)).toBe(true);
    });
});

describe('CustomerAnalyticsAdminResolver permission gates', () => {
    const proto = CustomerAnalyticsAdminResolver.prototype;

    it('gates customerSegmentExport behind UpdateCustomerAnalytics, not a view-only Read role', () => {
        const perms = permissionsFor(proto.customerSegmentExport);
        expect(perms).toContain(updateCustomerAnalyticsPermission.Permission);
        expect(perms).toContain(Permission.SuperAdmin);
        expect(perms).not.toContain(customerAnalyticsPermission.Permission);
    });

    it('keeps customerSegmentSummary readable by a view-only Read role', () => {
        const perms = permissionsFor(proto.customerSegmentSummary);
        expect(perms).toContain(customerAnalyticsPermission.Permission);
    });

    it('keeps customerSegmentList readable by a view-only Read role', () => {
        const perms = permissionsFor(proto.customerSegmentList);
        expect(perms).toContain(customerAnalyticsPermission.Permission);
    });
});

describe('CustomerAnalyticsAdminResolver.setRecencyThresholds', () => {
    it('persists a valid pair to both channel-scoped keys', async () => {
        const { resolver, settingsStore } = createResolver();
        const actual = await resolver.setRecencyThresholds(ctx, {
            activeWithinDays: 20,
            atRiskUntilDays: 60,
        });
        expect(actual).toEqual({ activeWithinDays: 20, atRiskUntilDays: 60 });
        expect(settingsStore.set).toHaveBeenCalledTimes(2);
        expect(settingsStore.set).toHaveBeenCalledWith(SETTING_ACTIVE, 20, ctx);
        expect(settingsStore.set).toHaveBeenCalledWith(SETTING_AT_RISK, 60, ctx);
    });

    it('rejects atRisk <= active and writes nothing', async () => {
        const { resolver, settingsStore } = createResolver();
        await expect(
            resolver.setRecencyThresholds(ctx, { activeWithinDays: 60, atRiskUntilDays: 30 }),
        ).rejects.toThrow(/greater than/i);
        expect(settingsStore.set).not.toHaveBeenCalled();
    });

    it('rejects negative thresholds and writes nothing', async () => {
        const { resolver, settingsStore } = createResolver();
        await expect(
            resolver.setRecencyThresholds(ctx, { activeWithinDays: -1, atRiskUntilDays: 60 }),
        ).rejects.toThrow(/non-negative/i);
        expect(settingsStore.set).not.toHaveBeenCalled();
    });
});

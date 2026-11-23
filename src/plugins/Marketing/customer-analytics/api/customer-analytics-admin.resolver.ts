import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
    Allow,
    CustomerGroup,
    CustomerGroupService,
    Ctx,
    ID,
    JsonCompatible,
    Permission,
    RequestContext,
    SettingsStoreService,
    Transaction,
} from '@vendure/core';
import { assertValidThresholds, CustomerSegmentState, RecencyThresholds } from '../services/classify-recency';
import { CustomerSegmentService } from '../services/customer-segment.service';
import { customerAnalyticsPermission, updateCustomerAnalyticsPermission } from '../permissions';

const SETTING_ACTIVE = 'customerAnalytics.activeWithinDays';
const SETTING_AT_RISK = 'customerAnalytics.atRiskUntilDays';
const DEFAULT_ACTIVE_WITHIN_DAYS = 30;
const DEFAULT_AT_RISK_UNTIL_DAYS = 60;
// Page size for reading existing group members. MUST stay <= the server's
// apiOptions.adminListQueryLimit (2000 here) — getGroupCustomers runs through
// Vendure's ListQueryBuilder, which throws list-query-limit-exceeded above it.
const GROUP_PAGE_SIZE = 1000;
// Chunk size for bulk membership writes. Bounds the IN-clause / packet size when
// a segment has tens of thousands of customers (e.g. Never-ordered).
const GROUP_WRITE_CHUNK = 500;

const STATE_LABELS: Record<CustomerSegmentState, string> = {
    ACTIVE: 'Active',
    AT_RISK: 'At-Risk',
    CHURN: 'Churn',
    NEVER: 'Never-ordered',
};

@Resolver()
export class CustomerAnalyticsAdminResolver {
    constructor(
        private segmentService: CustomerSegmentService,
        private settingsStore: SettingsStoreService,
        private customerGroupService: CustomerGroupService,
    ) {}

    @Query()
    @Allow(customerAnalyticsPermission.Permission, Permission.SuperAdmin)
    async customerSegmentSummary(@Ctx() ctx: RequestContext) {
        const thresholds = await this.readThresholds(ctx);
        const summary = await this.segmentService.computeSummary(ctx, thresholds);
        const savedStates = await this.findSavedStates(ctx);
        return { ...summary, config: thresholds, savedStates };
    }

    /** States whose stable default group already exists for this channel (Save vs Sync). */
    private async findSavedStates(ctx: RequestContext): Promise<CustomerSegmentState[]> {
        const states = Object.keys(STATE_LABELS) as CustomerSegmentState[];
        const checks = await Promise.all(
            states.map(async state => {
                const found = await this.findGroupByName(ctx, this.defaultGroupName(ctx, state));
                return { state, exists: Boolean(found) };
            }),
        );
        return checks.filter(check => check.exists).map(check => check.state);
    }

    @Query()
    @Allow(customerAnalyticsPermission.Permission, Permission.SuperAdmin)
    async customerSegmentList(
        @Ctx() ctx: RequestContext,
        @Args() args: { state: CustomerSegmentState; options?: { skip?: number; take?: number } },
    ) {
        const thresholds = await this.readThresholds(ctx);
        return this.segmentService.listByState(ctx, args.state, thresholds, args.options ?? {});
    }

    @Query()
    // Bulk CSV export of customer PII (emails + phone numbers) — gated above the
    // view-only Read role so a viewer can see the dashboard but not extract the data.
    @Allow(updateCustomerAnalyticsPermission.Permission, Permission.SuperAdmin)
    async customerSegmentExport(
        @Ctx() ctx: RequestContext,
        @Args() args: { state: CustomerSegmentState },
    ) {
        const thresholds = await this.readThresholds(ctx);
        return this.segmentService.exportByState(ctx, args.state, thresholds);
    }

    @Mutation()
    @Allow(updateCustomerAnalyticsPermission.Permission, Permission.SuperAdmin)
    async setRecencyThresholds(
        @Ctx() ctx: RequestContext,
        @Args() args: { activeWithinDays: number; atRiskUntilDays: number },
    ): Promise<RecencyThresholds> {
        const thresholds: RecencyThresholds = {
            activeWithinDays: Number(args.activeWithinDays),
            atRiskUntilDays: Number(args.atRiskUntilDays),
        };
        assertValidThresholds(thresholds);
        await this.writeThreshold(ctx, SETTING_ACTIVE, thresholds.activeWithinDays);
        await this.writeThreshold(ctx, SETTING_AT_RISK, thresholds.atRiskUntilDays);
        return thresholds;
    }

    @Transaction()
    @Mutation()
    @Allow(Permission.UpdateCustomerGroup, Permission.SuperAdmin)
    async saveCustomerSegmentAsGroup(
        @Ctx() ctx: RequestContext,
        @Args() args: { state: CustomerSegmentState; groupName?: string },
    ): Promise<CustomerGroup> {
        const thresholds = await this.readThresholds(ctx);
        const customerIds = await this.segmentService.listCustomerIds(ctx, args.state, thresholds);
        const name = args.groupName?.trim() || this.defaultGroupName(ctx, args.state);
        return this.upsertGroup(ctx, name, customerIds);
    }

    /**
     * Writes one channel-scoped threshold. SettingsStore accepts any JSON at runtime, but
     * its `set` generic constraint (JsonCompatible<any>) resolves to an object-only type and
     * rejects bare numbers — an upstream typing quirk (core's own JSDoc passes a primitive).
     * The cast is localized here so the one workaround lives in a single documented place.
     */
    private async writeThreshold(ctx: RequestContext, key: string, value: number): Promise<void> {
        await this.settingsStore.set(key, value as unknown as JsonCompatible<any>, ctx);
    }

    /** Reads channel-scoped thresholds, falling back to defaults, then validates. */
    private async readThresholds(ctx: RequestContext): Promise<RecencyThresholds> {
        const activeWithinDays =
            (await this.settingsStore.get(SETTING_ACTIVE, ctx)) ?? DEFAULT_ACTIVE_WITHIN_DAYS;
        const atRiskUntilDays =
            (await this.settingsStore.get(SETTING_AT_RISK, ctx)) ?? DEFAULT_AT_RISK_UNTIL_DAYS;
        const thresholds: RecencyThresholds = {
            activeWithinDays: Number(activeWithinDays),
            atRiskUntilDays: Number(atRiskUntilDays),
        };
        assertValidThresholds(thresholds);
        return thresholds;
    }

    /**
     * Channel-namespaced, stable group name (CustomerGroup is not channel-aware). No date:
     * one living group per channel+segment, so re-saving syncs members in place rather than
     * spawning a dated duplicate each day. upsertGroup matches on this exact name.
     */
    private defaultGroupName(ctx: RequestContext, state: CustomerSegmentState): string {
        return `${ctx.channel.code} ${STATE_LABELS[state]}`;
    }

    /**
     * Create-or-sync: find the same-named group (or create it empty), then replace its
     * members with the segment. Both reads and writes are bounded so a 25k-member segment
     * stays under the list-query limit and avoids oversized membership queries.
     */
    private async upsertGroup(ctx: RequestContext, name: string, customerIds: ID[]): Promise<CustomerGroup> {
        const found = await this.findGroupByName(ctx, name);
        const group = found ?? (await this.customerGroupService.create(ctx, { name, customerIds: [] }));
        await this.replaceMembers(ctx, group.id, customerIds);
        return this.customerGroupService.findOne(ctx, group.id) as Promise<CustomerGroup>;
    }

    /** Finds an existing group by exact name, or undefined. */
    private async findGroupByName(ctx: RequestContext, name: string): Promise<CustomerGroup | undefined> {
        const existing = await this.customerGroupService.findAll(ctx, { filter: { name: { eq: name } } });
        return existing.items.find(group => group.name === name);
    }

    /** Replaces a group's membership: drop every current member, add the new set. */
    private async replaceMembers(ctx: RequestContext, groupId: ID, customerIds: ID[]): Promise<void> {
        const currentIds = await this.fetchAllGroupMemberIds(ctx, groupId);
        await this.removeInBatches(ctx, groupId, currentIds);
        await this.addInBatches(ctx, groupId, customerIds);
    }

    /** Reads every member id of a group, paging under the list-query limit. */
    private async fetchAllGroupMemberIds(ctx: RequestContext, groupId: ID): Promise<ID[]> {
        const ids: ID[] = [];
        let skip = 0;
        for (;;) {
            const page = await this.customerGroupService.getGroupCustomers(ctx, groupId, {
                take: GROUP_PAGE_SIZE,
                skip,
            });
            ids.push(...page.items.map(customer => customer.id));
            skip += GROUP_PAGE_SIZE;
            if (page.items.length === 0 || ids.length >= page.totalItems) {
                return ids;
            }
        }
    }

    /** Removes members in bounded chunks; no-op on an empty set. */
    private async removeInBatches(ctx: RequestContext, groupId: ID, customerIds: ID[]): Promise<void> {
        for (const batch of this.chunk(customerIds, GROUP_WRITE_CHUNK)) {
            await this.customerGroupService.removeCustomersFromGroup(ctx, {
                customerGroupId: groupId,
                customerIds: batch,
            });
        }
    }

    /** Adds members in bounded chunks; no-op on an empty set. */
    private async addInBatches(ctx: RequestContext, groupId: ID, customerIds: ID[]): Promise<void> {
        for (const batch of this.chunk(customerIds, GROUP_WRITE_CHUNK)) {
            await this.customerGroupService.addCustomersToGroup(ctx, {
                customerGroupId: groupId,
                customerIds: batch,
            });
        }
    }

    /** Splits an array into fixed-size chunks. */
    private chunk<T>(items: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < items.length; i += size) {
            chunks.push(items.slice(i, i + size));
        }
        return chunks;
    }
}

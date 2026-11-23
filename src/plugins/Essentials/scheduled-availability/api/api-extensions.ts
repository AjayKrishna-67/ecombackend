import gql from 'graphql-tag';

/**
 * Admin API for scheduled availability. Every operation is SuperAdmin-only;
 * see the resolver for the gate itself.
 */
export const adminApiExtensions = gql`
    enum AvailabilityTargetType {
        Product
        Collection
    }

    enum AvailabilityAction {
        ENABLE
        DISABLE
        SEND
    }

    """
    What a rule does when it fires.

    A separate discriminator rather than a third AvailabilityTargetType: that
    enum means "product or collection" to the target picker, the target-name
    decorator and the applier registry.
    """
    enum ScheduleKind {
        AVAILABILITY
        REPORT
    }

    enum ScheduledReportType {
        PURCHASE_LIST
    }

    "Which orders a report covers, resolved in the rule's own timezone."
    enum ReportDateRangeMode {
        TODAY
        YESTERDAY
    }

    enum AvailabilityScheduleMode {
        ONE_OFF
        RECURRING
    }

    enum AvailabilityRunStatus {
        PENDING
        RUNNING
        DONE
        NOOP
        FAILED
        SKIPPED
        CLOSED
        CANCELLED
    }

    type AvailabilitySchedule implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        "AVAILABILITY flips a product or collection; REPORT delivers a document."
        kind: ScheduleKind!
        "Null on REPORT rules."
        targetType: AvailabilityTargetType
        "Null on REPORT rules."
        targetId: ID
        "REPORT only. A report has one pattern, not a hide/show pair."
        sendCron: String
        reportType: ScheduledReportType
        """
        REPORT only. Brand the report aggregates over. Deliberately distinct from
        the channel field below, which is the channel that owns the rule.

        Member channels are resolved at run time, so a city added to the brand
        later is picked up by rules that already exist.
        """
        reportSellerId: ID
        "REPORT only. The brand's name, for display. Null if the seller was deleted."
        reportSellerName: String
        "REPORT only. The brand's member channels, resolved now -- what a run would cover."
        reportChannels: [Channel!]
        """
        SUPERSEDED by reportSellerId and no longer read. Retained so existing
        rows keep their history; treat any value here as stale.
        """
        reportChannelIds: [ID!]
        "REPORT only. Recipient phone numbers, E.164 without the plus."
        recipients: [String!]
        dateRangeMode: ReportDateRangeMode
        channel: Channel!
        mode: AvailabilityScheduleMode!
        runAt: DateTime
        action: AvailabilityAction
        disableCron: String
        enableCron: String
        timezone: String!
        activeFrom: DateTime
        activeUntil: DateTime
        isEnabled: Boolean!
        label: String
        createdByAdmin: Administrator
        "Most recent executed run, or null if this rule has never fired."
        latestRun: AvailabilityScheduleRun
        "Earliest run still pending, or null if nothing is materialised ahead."
        nextRun: AvailabilityScheduleRun
        "Display name of the target, resolved in this rule's channel. Null if it was deleted."
        targetName: String
        """
        The target's featured asset, if it has one.

        Typed as Asset rather than as a preview String on purpose: core's
        AssetInterceptorPlugin walks the GraphQL output type tree and rewrites
        preview/source to absolute URLs only for fields whose type is named
        Asset. A String would be emitted as the raw stored path and would not
        load in a browser.
        """
        targetAsset: Asset
    }

    type AvailabilityScheduleRun implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        dueAt: DateTime!
        action: AvailabilityAction!
        status: AvailabilityRunStatus!
        attempts: Int!
        lastError: String
        "Outcome detail. On NOOP, names who left the target in the wanted state."
        note: String
        executedAt: DateTime
    }

    type AvailabilityOccurrence {
        dueAt: DateTime!
        action: AvailabilityAction!
    }

    "A product or collection that a schedule could target."
    type AvailabilityTarget {
        id: ID!
        name: String!
        "Featured asset. Asset-typed so its URL is made absolute on the way out."
        asset: Asset
    }

    type AvailabilityScheduleList implements PaginatedList {
        items: [AvailabilitySchedule!]!
        totalItems: Int!
    }

    type AvailabilityScheduleRunList implements PaginatedList {
        items: [AvailabilityScheduleRun!]!
        totalItems: Int!
    }

    input AvailabilityScheduleSortParameter {
        id: SortOrder
        createdAt: SortOrder
        updatedAt: SortOrder
        runAt: SortOrder
        label: SortOrder
        timezone: SortOrder
    }

    """
    _and / _or exist because the Dashboard data table always wraps its active
    column filters in an _and array. Without them every faceted filter would be
    rejected as an unknown input field.

    There is no channel filter: schedules are channel-aware, so the list is
    already scoped to the channel on the request context.

    Entity columns -- id, createdAt, updatedAt, runAt, targetName and the rest --
    are NOT listed here on purpose: Vendure appends them to this input itself from
    the entity, so declaring them again is noise. Only the fields it cannot infer
    belong here.
    """
    input AvailabilityScheduleFilterParameter {
        _and: [AvailabilityScheduleFilterParameter!]
        _or: [AvailabilityScheduleFilterParameter!]
        kind: StringOperators
        targetType: StringOperators
        mode: StringOperators
        isEnabled: BooleanOperators
        label: StringOperators
        timezone: StringOperators
    }

    input AvailabilityScheduleListOptions {
        skip: Int
        take: Int
        sort: AvailabilityScheduleSortParameter
        filter: AvailabilityScheduleFilterParameter
    }

    input AvailabilityScheduleRunSortParameter {
        id: SortOrder
        dueAt: SortOrder
        executedAt: SortOrder
    }

    input AvailabilityScheduleRunFilterParameter {
        _and: [AvailabilityScheduleRunFilterParameter!]
        _or: [AvailabilityScheduleRunFilterParameter!]
        status: StringOperators
        action: StringOperators
    }

    input AvailabilityScheduleRunListOptions {
        skip: Int
        take: Int
        sort: AvailabilityScheduleRunSortParameter
        filter: AvailabilityScheduleRunFilterParameter
    }

    input CreateAvailabilityScheduleInput {
        "Defaults to AVAILABILITY when omitted, so existing callers keep working."
        kind: ScheduleKind
        "Required for AVAILABILITY, forbidden for REPORT."
        targetType: AvailabilityTargetType
        "Required for AVAILABILITY, forbidden for REPORT."
        targetId: ID
        "REPORT only. 5-field cron pattern read in the rule's timezone."
        sendCron: String
        reportType: ScheduledReportType
        "REPORT only. The brand to report on; its channels resolve at run time."
        reportSellerId: ID
        recipients: [String!]
        dateRangeMode: ReportDateRangeMode
        channelId: ID!
        mode: AvailabilityScheduleMode!
        "ONE_OFF only. Sent and stored as UTC."
        runAt: DateTime
        "ONE_OFF only."
        action: AvailabilityAction
        "RECURRING only. 5-field cron pattern read in the rule's timezone."
        disableCron: String
        "RECURRING only."
        enableCron: String
        "IANA zone. Defaults to Asia/Kolkata."
        timezone: String
        activeFrom: DateTime
        activeUntil: DateTime
        label: String
    }

    input UpdateAvailabilityScheduleInput {
        id: ID!
        targetType: AvailabilityTargetType
        targetId: ID
        sendCron: String
        reportType: ScheduledReportType
        reportSellerId: ID
        recipients: [String!]
        dateRangeMode: ReportDateRangeMode
        mode: AvailabilityScheduleMode
        runAt: DateTime
        action: AvailabilityAction
        disableCron: String
        enableCron: String
        timezone: String
        activeFrom: DateTime
        activeUntil: DateTime
        label: String
    }

    extend type Query {
        """
        Lists schedules belonging to the active channel.

        Channel-aware: the scope comes from the channel on the request context,
        the same way products and collections behave.

        Pass allChannels: true for a read-only overview across every channel the
        caller holds SuperAdmin on. The rows are still only mutatable from their
        own channel -- availabilitySchedule(id) and every mutation stay scoped to
        the context -- so this widens what can be seen, never what can be done.
        """
        availabilitySchedules(
            options: AvailabilityScheduleListOptions
            allChannels: Boolean
        ): AvailabilityScheduleList!
        "Null if the schedule does not exist in the active channel."
        availabilitySchedule(id: ID!): AvailabilitySchedule
        availabilityScheduleRuns(
            scheduleId: ID!
            options: AvailabilityScheduleRunListOptions
        ): AvailabilityScheduleRunList!
        """
        Searches products or collections **within a given channel**.

        The built-in products and collections queries resolve against the
        channel on the request token, which is the channel the admin happens to
        be browsing -- not the channel the schedule will belong to. Picking a
        target from the wrong channel produces a rule that can never succeed, so
        the picker needs to search where the rule will actually run.

        NOTE: no backticks in these descriptions. This whole schema is a JS
        template literal, and a backtick terminates it.
        """
        availabilityTargetSearch(
            targetType: AvailabilityTargetType!
            channelId: ID!
            term: String!
        ): [AvailabilityTarget!]!
        "Computes the next occurrences of an unsaved rule. Persists nothing."
        previewAvailabilitySchedule(
            input: CreateAvailabilityScheduleInput!
            count: Int
        ): [AvailabilityOccurrence!]!
    }

    extend type Mutation {
        createAvailabilitySchedule(input: CreateAvailabilityScheduleInput!): AvailabilitySchedule!
        updateAvailabilitySchedule(input: UpdateAvailabilityScheduleInput!): AvailabilitySchedule!
        deleteAvailabilitySchedule(id: ID!): Boolean!
        setAvailabilityScheduleEnabled(id: ID!, isEnabled: Boolean!): AvailabilitySchedule!
        cancelAvailabilityScheduleRun(runId: ID!): Boolean!
        "Materialises and drains one rule immediately, without waiting for the sweep."
        runAvailabilityScheduleNow(id: ID!): Boolean!
    }
`;

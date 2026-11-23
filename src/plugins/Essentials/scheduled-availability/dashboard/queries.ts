import { graphql } from '@vendure/dashboard';

export type AvailabilityTargetType = 'Product' | 'Collection';
export type AvailabilityAction = 'ENABLE' | 'DISABLE' | 'SEND';
export type AvailabilityScheduleMode = 'ONE_OFF' | 'RECURRING';
/** AVAILABILITY flips a product or collection; REPORT delivers a document. */
export type ScheduleKind = 'AVAILABILITY' | 'REPORT';
export type ScheduledReportType = 'PURCHASE_LIST';
export type ReportDateRangeMode = 'TODAY' | 'YESTERDAY';
export type AvailabilityRunStatus =
    | 'PENDING'
    | 'RUNNING'
    | 'DONE'
    | 'NOOP'
    | 'FAILED'
    | 'SKIPPED'
    | 'CLOSED'
    | 'CANCELLED';

/** The subset of Asset the thumbnails need. Matches the dashboard's AssetLike. */
export interface TargetAsset {
    id: string;
    name?: string | null;
    preview: string;
    focalPoint?: { x: number; y: number } | null;
}

export interface AvailabilityRunRow {
    id: string;
    dueAt: string;
    action: AvailabilityAction;
    status: AvailabilityRunStatus;
    attempts: number;
    lastError: string | null;
    note: string | null;
    executedAt: string | null;
}

export interface AvailabilityScheduleRow {
    id: string;
    kind: ScheduleKind;
    /** Null on REPORT rules. */
    targetType: AvailabilityTargetType | null;
    /** Null on REPORT rules. */
    targetId: string | null;
    /** REPORT only. */
    sendCron: string | null;
    reportType: ScheduledReportType | null;
    /** REPORT only. The brand; its channels resolve at run time, not on save. */
    reportSellerId: string | null;
    reportSellerName: string | null;
    reportChannels: Array<{ id: string; code: string }> | null;
    recipients: string[] | null;
    dateRangeMode: ReportDateRangeMode | null;
    targetName: string | null;
    targetAsset: TargetAsset | null;
    channel: { id: string; code: string };
    mode: AvailabilityScheduleMode;
    runAt: string | null;
    action: AvailabilityAction | null;
    disableCron: string | null;
    enableCron: string | null;
    timezone: string;
    activeFrom: string | null;
    activeUntil: string | null;
    isEnabled: boolean;
    label: string | null;
    createdByAdmin: { id: string; firstName: string; lastName: string } | null;
    latestRun: AvailabilityRunRow | null;
    nextRun: AvailabilityRunRow | null;
}

export interface TargetOption {
    id: string;
    name: string;
    asset?: TargetAsset | null;
}

/**
 * Every schedule field the UI reads, in one fragment-shaped block.
 *
 * Repeated literally in the list and detail documents rather than shared via a
 * GraphQL fragment: gql.tada types each document independently, and a shared
 * fragment would need its type threaded through both call sites for no gain at
 * this size.
 */
export const getAvailabilitySchedulesDocument = graphql(`
    query GetAvailabilitySchedules($options: AvailabilityScheduleListOptions) {
        availabilitySchedules(options: $options) {
            items {
                id
                kind
                targetType
                targetId
                sendCron
                reportType
                reportSellerId
                reportSellerName
                reportChannels {
                    id
                    code
                }
                recipients
                dateRangeMode
                targetName
                targetAsset {
                    id
                    name
                    preview
                    focalPoint {
                        x
                        y
                    }
                }
                mode
                runAt
                action
                disableCron
                enableCron
                timezone
                activeFrom
                activeUntil
                isEnabled
                label
                createdByAdmin {
                    id
                    firstName
                    lastName
                }
                latestRun {
                    id
                    dueAt
                    action
                    status
                    attempts
                    lastError
                    note
                    executedAt
                }
                nextRun {
                    id
                    dueAt
                    action
                    status
                    attempts
                    lastError
                    note
                    executedAt
                }
            }
            totalItems
        }
    }
`);

export const getAvailabilityScheduleDocument = graphql(`
    query GetAvailabilitySchedule($id: ID!) {
        availabilitySchedule(id: $id) {
            id
            kind
            targetType
            targetId
            sendCron
            reportType
            reportSellerId
            reportSellerName
            reportChannels {
                id
                code
            }
            recipients
            dateRangeMode
            targetName
            targetAsset {
                id
                name
                preview
                focalPoint {
                    x
                    y
                }
            }
            channel {
                id
                code
            }
            mode
            runAt
            action
            disableCron
            enableCron
            timezone
            activeFrom
            activeUntil
            isEnabled
            label
            createdByAdmin {
                id
                firstName
                lastName
            }
            latestRun {
                id
                dueAt
                action
                status
                attempts
                lastError
                note
                executedAt
            }
            nextRun {
                id
                dueAt
                action
                status
                attempts
                lastError
                note
                executedAt
            }
        }
    }
`);

export const getAvailabilityScheduleRunsDocument = graphql(`
    query GetAvailabilityScheduleRuns($scheduleId: ID!) {
        availabilityScheduleRuns(
            scheduleId: $scheduleId
            options: { take: 50, sort: { dueAt: DESC } }
        ) {
            items {
                id
                dueAt
                action
                status
                attempts
                lastError
                note
                executedAt
            }
            totalItems
        }
    }
`);

export const previewAvailabilityScheduleDocument = graphql(`
    query PreviewAvailabilitySchedule($input: CreateAvailabilityScheduleInput!, $count: Int) {
        previewAvailabilitySchedule(input: $input, count: $count) {
            dueAt
            action
        }
    }
`);

export const createAvailabilityScheduleDocument = graphql(`
    mutation CreateAvailabilitySchedule($input: CreateAvailabilityScheduleInput!) {
        createAvailabilitySchedule(input: $input) {
            id
        }
    }
`);

export const updateAvailabilityScheduleDocument = graphql(`
    mutation UpdateAvailabilitySchedule($input: UpdateAvailabilityScheduleInput!) {
        updateAvailabilitySchedule(input: $input) {
            id
        }
    }
`);

export const deleteAvailabilityScheduleDocument = graphql(`
    mutation DeleteAvailabilitySchedule($id: ID!) {
        deleteAvailabilitySchedule(id: $id)
    }
`);

export const setAvailabilityScheduleEnabledDocument = graphql(`
    mutation SetAvailabilityScheduleEnabled($id: ID!, $isEnabled: Boolean!) {
        setAvailabilityScheduleEnabled(id: $id, isEnabled: $isEnabled) {
            id
            isEnabled
        }
    }
`);

export const runAvailabilityScheduleNowDocument = graphql(`
    mutation RunAvailabilityScheduleNow($id: ID!) {
        runAvailabilityScheduleNow(id: $id)
    }
`);

export const cancelAvailabilityScheduleRunDocument = graphql(`
    mutation CancelAvailabilityScheduleRun($runId: ID!) {
        cancelAvailabilityScheduleRun(runId: $runId)
    }
`);

/**
 * Searches inside the channel the schedule will belong to, not the channel the
 * admin happens to be browsing. The built-in `products` / `collections` queries
 * cannot do this -- they resolve against the request token's channel -- which is
 * how a rule can be created for a collection that does not exist where it runs.
 */
export const availabilityTargetSearchDocument = graphql(`
    query AvailabilityTargetSearch(
        $targetType: AvailabilityTargetType!
        $channelId: ID!
        $term: String!
    ) {
        availabilityTargetSearch(targetType: $targetType, channelId: $channelId, term: $term) {
            id
            name
            asset {
                id
                name
                preview
                focalPoint {
                    x
                    y
                }
            }
        }
    }
`);

/**
 * Brands and their member channels, for the report scope picker.
 *
 * Vendure's channel context carries no seller, so the grouping cannot be done
 * from what the Dashboard already has in memory. Reading it from core's own
 * channels query keeps this plugin free of a resolver whose only job would be
 * to re-expose data the admin API already serves.
 */
export const getReportBrandsDocument = graphql(`
    query GetReportBrands {
        channels(options: { take: 100 }) {
            items {
                id
                code
                seller {
                    id
                    name
                }
            }
        }
    }
`);

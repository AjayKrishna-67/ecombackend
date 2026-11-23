import { graphql } from '@vendure/dashboard';

export const getAdminActivityLogsDocument = graphql(`
    query GetAdminActivityLogs($options: AdminActivityLogListOptions) {
        adminActivityLogs(options: $options) {
            items {
                id
                createdAt
                operationName
                entityType
                entityId
                targetCount
                payload
                changedFields
                changes {
                    path
                    from
                    to
                }
                entityLabel
                entityLink
                outcome
                errorMessage
                adminId
                adminName
                sessionId
                channelId
                ipAddress
                userAgent
                durationMs
                isAuthEvent
            }
            totalItems
        }
    }
`);

export const getAdminActivitySessionsDocument = graphql(`
    query GetAdminActivitySessions($skip: Int, $take: Int, $adminId: ID, $since: DateTime) {
        adminActivitySessions(skip: $skip, take: $take, adminId: $adminId, since: $since) {
            items {
                sessionId
                adminId
                adminName
                ipAddress
                userAgent
                startedAt
                endedAt
                actionCount
                errorCount
                entityTypes
            }
            totalItems
        }
    }
`);

export const getAdminActivitySessionTimelineDocument = graphql(`
    query GetAdminActivitySessionTimeline($sessionId: String!) {
        adminActivitySessionTimeline(sessionId: $sessionId) {
            id
            createdAt
            operationName
            entityType
            entityId
            targetCount
            payload
            changedFields
            changes {
                path
                from
                to
            }
            entityLabel
            entityLink
            outcome
            errorMessage
            adminName
            ipAddress
            userAgent
            durationMs
            isAuthEvent
        }
    }
`);

export const getAdminActivityForEntityDocument = graphql(`
    query GetAdminActivityForEntity($entityType: String!, $entityId: String!, $take: Int) {
        adminActivityForEntity(entityType: $entityType, entityId: $entityId, take: $take) {
            id
            createdAt
            operationName
            entityType
            entityId
            targetCount
            payload
            changedFields
            changes {
                path
                from
                to
            }
            entityLabel
            entityLink
            outcome
            errorMessage
            adminId
            adminName
            sessionId
            ipAddress
            userAgent
            durationMs
            isAuthEvent
        }
    }
`);

/** One field a mutation changed, with the value on either side. */
export interface AdminActivityFieldChange {
    path: string;
    from: unknown;
    to: unknown;
}

export interface AdminActivityLogRow {
    id: string;
    createdAt: string;
    operationName: string;
    entityType: string | null;
    entityId: string | null;
    targetCount: number;
    payload: Record<string, unknown> | null;
    changedFields: string[] | null;
    changes: AdminActivityFieldChange[] | null;
    entityLabel: string | null;
    entityLink: string | null;
    outcome: 'SUCCESS' | 'ERROR';
    errorMessage: string | null;
    adminId: string | null;
    adminName: string;
    sessionId: string | null;
    channelId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    durationMs: number;
    isAuthEvent: boolean;
}

export interface AdminActivitySessionRow {
    sessionId: string;
    adminId: string | null;
    adminName: string;
    ipAddress: string | null;
    userAgent: string | null;
    startedAt: string;
    endedAt: string;
    actionCount: number;
    errorCount: number;
    entityTypes: string[];
}

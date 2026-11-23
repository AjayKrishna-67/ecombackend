import gql from 'graphql-tag';

/**
 * Admin API surface for the activity log.
 *
 * `AdminActivityLogListOptions` is declared empty on purpose: Vendure generates
 * the filter and sort inputs from the entity's own fields, so the Dashboard gets
 * standard list semantics without this file restating every column.
 */
export const adminApiExtensions = gql`
    """
    One field a mutation changed, with the value on either side. Derived at read
    time from the two stored payloads rather than persisted, so it is available
    on rows written before this field existed.
    """
    type AdminActivityFieldChange {
        "Dotted path, e.g. stockLevels.2.stockOnHand or translations.ta.name."
        path: String!
        "Value before the change. Null also stands for an array member that did not exist yet."
        from: JSON
        "Value after the change. Null also stands for an array member that was removed."
        to: JSON
    }

    type AdminActivityLog implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        operationName: String!
        entityType: String
        entityId: String
        targetCount: Int!
        payload: JSON
        """
        Dotted paths of the fields this mutation actually changed, diffed against
        the previous recorded change to the same entity. Null when no comparison
        was possible: the first change to an entity, a create/delete, or a
        failure.
        """
        changedFields: [String!]
        """
        The same diff as changedFields, carrying the before and after value for
        each path. Null under exactly the same conditions.
        """
        changes: [AdminActivityFieldChange!]
        """
        Display name of the target entity as it was WHEN THE ACTION HAPPENED,
        read from this row's own payload. Null when the payload carries no name.
        """
        entityLabel: String
        """
        Dashboard path for the target entity, e.g. /product-variants/949. Null
        when the entity type has no detail page or was never recognised — the UI
        must render the target as plain text in that case rather than guessing.
        """
        entityLink: String
        outcome: String!
        errorMessage: String
        adminId: ID
        adminName: String!
        sessionId: String
        channelId: ID
        ipAddress: String
        "Resolved from the row's Session. Null on rows whose session is gone."
        userAgent: String
        durationMs: Int!
        isAuthEvent: Boolean!
    }

    type AdminActivityLogList implements PaginatedList {
        items: [AdminActivityLog!]!
        totalItems: Int!
    }

    "One device session: who worked, from where, for how long, and how much they touched."
    type AdminActivitySession {
        sessionId: String!
        adminId: ID
        adminName: String!
        ipAddress: String
        "Raw UA string. Parsed into browser, OS and device type by the Dashboard."
        userAgent: String
        startedAt: DateTime!
        endedAt: DateTime!
        actionCount: Int!
        errorCount: Int!
        entityTypes: [String!]!
    }

    """
    Deliberately does NOT declare 'implements PaginatedList'. That interface
    requires 'items: [Node!]!', and a session summary is an aggregate over log
    rows rather than an entity, so it has no id and cannot implement Node. The
    shape is still { items, totalItems }, so the Dashboard list components read
    it exactly like any other paginated result.
    """
    type AdminActivitySessionList {
        items: [AdminActivitySession!]!
        totalItems: Int!
    }

    input AdminActivityLogListOptions

    extend type Query {
        "Paginated, filterable list of every recorded admin action."
        adminActivityLogs(options: AdminActivityLogListOptions): AdminActivityLogList!

        "Full recorded history for one entity, e.g. every action against Product 412."
        adminActivityForEntity(entityType: String!, entityId: String!, take: Int): [AdminActivityLog!]!

        "One row per device session, newest first."
        adminActivitySessions(
            skip: Int
            take: Int
            adminId: ID
            since: DateTime
        ): AdminActivitySessionList!

        "Ordered timeline of everything done within a single device session."
        adminActivitySessionTimeline(sessionId: String!): [AdminActivityLog!]!
    }
`;

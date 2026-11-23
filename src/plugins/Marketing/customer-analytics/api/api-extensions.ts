import gql from 'graphql-tag';

export const adminApiExtensions = gql`
    enum CustomerSegmentState {
        ACTIVE
        AT_RISK
        CHURN
        NEVER
    }

    type CustomerSegmentConfig {
        activeWithinDays: Int!
        atRiskUntilDays: Int!
    }

    type CustomerSegmentSummary {
        active: Int!
        atRisk: Int!
        churn: Int!
        never: Int!
        config: CustomerSegmentConfig!
        "States that already have a saved CustomerGroup for this channel (drives Save vs Sync)."
        savedStates: [CustomerSegmentState!]!
    }

    type CustomerSegmentRow {
        customerId: ID!
        firstName: String!
        lastName: String!
        emailAddress: String!
        lastOrderAt: DateTime
        daysSinceLastOrder: Int
        state: CustomerSegmentState!
    }

    type CustomerSegmentRowList {
        items: [CustomerSegmentRow!]!
        totalItems: Int!
    }

    "Customer row enriched with order aggregates for CSV export. totalOrderValue is in minor units (paise/cents)."
    type CustomerSegmentExportRow {
        customerId: ID!
        firstName: String!
        lastName: String!
        emailAddress: String!
        phoneNumber: String
        orderCount: Int!
        totalOrderValue: Int!
        lastOrderAt: DateTime
        state: CustomerSegmentState!
    }

    input CustomerSegmentListOptions {
        skip: Int
        take: Int
    }

    extend type Query {
        customerSegmentSummary: CustomerSegmentSummary!
        customerSegmentList(state: CustomerSegmentState!, options: CustomerSegmentListOptions): CustomerSegmentRowList!
        "Returns every customer in a segment (capped) with order aggregates, for CSV export."
        customerSegmentExport(state: CustomerSegmentState!): [CustomerSegmentExportRow!]!
    }

    extend type Mutation {
        """
        Syncs the current members of a recency segment into a stable CustomerGroup named
        "<channelCode> <State>" (create on first save, replace members on later saves).
        """
        saveCustomerSegmentAsGroup(state: CustomerSegmentState!, groupName: String): CustomerGroup!

        """
        Sets the channel-scoped recency thresholds. Validates the pair atomically
        (atRiskUntilDays > activeWithinDays >= 0) before persisting, so a bad pair can
        never reach the read path and break the analytics page.
        """
        setRecencyThresholds(activeWithinDays: Int!, atRiskUntilDays: Int!): CustomerSegmentConfig!
    }
`;


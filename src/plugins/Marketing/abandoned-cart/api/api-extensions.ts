import gql from 'graphql-tag';

export const adminApiExtensions = gql`
    type AbandonedCartBodyVar {
        kind: String!
        value: String!
    }
    type AbandonedCartStage {
        delayValue: Int!
        delayUnit: String!
        templateName: String!
        language: String!
        bodyVars: [AbandonedCartBodyVar!]!
        headerImageUrl: String
        buttonUrlParam: String
    }
    type AbandonedCartSettings {
        enabled: Boolean!
        minOrderValueMinor: Int
        costPerMessageMinor: Int!
        stages: [AbandonedCartStage!]!
    }

    type AbandonedCartStageCount {
        stage: Int!
        count: Int!
    }
    type AbandonedCartAnalytics {
        totalSent: Int!
        sentByStage: [AbandonedCartStageCount!]!
        conversions: Int!
        conversionsByStage: [AbandonedCartStageCount!]!
        conversionRate: Float!
        avgTimeToOrderSeconds: Float!
        revenueRecoveredMinor: Float!
        totalCostMinor: Float!
        roi: Float!
    }

    input AbandonedCartBodyVarInput {
        kind: String!
        value: String!
    }
    input AbandonedCartStageInput {
        delayValue: Int!
        delayUnit: String!
        templateName: String!
        language: String!
        bodyVars: [AbandonedCartBodyVarInput!]!
        headerImageUrl: String
        buttonUrlParam: String
    }
    input AbandonedCartSettingsInput {
        enabled: Boolean!
        minOrderValueMinor: Int
        costPerMessageMinor: Int!
        stages: [AbandonedCartStageInput!]!
    }

    extend type Query {
        abandonedCartSettings: AbandonedCartSettings!
        "Count of carts that would be nudged right now in the active channel."
        abandonedCartEligiblePreview: Int!
        "Channel-scoped analytics: messages sent, conversions by stage, conversion rate, avg time-to-order."
        abandonedCartAnalytics: AbandonedCartAnalytics!
    }
    extend type Mutation {
        setAbandonedCartSettings(input: AbandonedCartSettingsInput!): AbandonedCartSettings!
        "Test-only: immediately send stage N's template to one order's customer, bypassing timing/eligibility/dedupe."
        triggerAbandonedCartNudge(orderId: ID!, stage: Int!): Boolean!
        "Test-only: send stage N's template to ONE explicit phone number with sample token values. No order lookup, no fan-out."
        sendAbandonedCartTestToPhone(phone: String!, stage: Int!): Boolean!
    }
`;

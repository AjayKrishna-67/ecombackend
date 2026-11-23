import gql from 'graphql-tag';

export const commonApiExtensions = gql`
    enum ReferralStatus {
        REGISTERED
        ELIGIBLE
        CLAIMED
    }

    type Referral implements Node {
        id: ID!
        referralNumber: Int!
        createdAt: DateTime!
        updatedAt: DateTime!
        referrer: Customer!
        referredCustomer: Customer!
        order: Order
        status: ReferralStatus!
        points: Int!
        isScratched: Boolean!
        note: String
    }

    type ReferralList {
        items: [Referral!]!
        totalItems: Int!
    }

    type ReferralChannelPoints implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        points: Int!
        channels: [Channel!]!
    }

    extend type Customer {
        referredBy: Referral
    }
`;

export const adminApiExtensions = gql`
    ${commonApiExtensions}

    input ReferralChannelPointsInput {
        points: Int!
    }

    type ReferralSummary {
        totalReferrals: Int!
        registered: Int!
        eligible: Int!
        claimed: Int!
    }

    type ReferralSummaryReport {
        today: ReferralSummary!
        yesterday: ReferralSummary!
        allTime: ReferralSummary!
    }

    extend type Query {
        referralChannelPoints: ReferralChannelPoints
        referrals(take: Int, skip: Int): ReferralList!
        referralsForCustomer(customerId: ID!, take: Int, skip: Int): ReferralList!
        referredByForCustomer(customerId: ID!): Referral
        referralSummary: ReferralSummaryReport!
    }

    extend type Mutation {
        createReferralChannelPoints(input: ReferralChannelPointsInput!): ReferralChannelPoints!
        updateReferralChannelPoints(id: ID!, input: ReferralChannelPointsInput!): ReferralChannelPoints!
        deleteReferralChannelPoints(id: ID!): Boolean!
        checkReferralEligibility(referralId: ID!): Referral!
    }
`;

export const shopApiExtensions = gql`
    ${commonApiExtensions}

    extend type Query {
        myReferrals(take: Int, skip: Int, status: ReferralStatus): ReferralList!
        earnedScratchCards(take: Int, skip: Int): ReferralList!
        scratchedCards(take: Int, skip: Int): ReferralList!
        referralChannelPoints: ReferralChannelPoints
    }

    extend type Mutation {
        registerReferral(referrerId: ID!): Referral!
        scratchReferralCard(referralNumber: Int!): Referral!
    }
`;

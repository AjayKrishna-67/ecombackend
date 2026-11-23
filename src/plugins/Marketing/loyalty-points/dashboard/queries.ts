import { graphql } from '@vendure/dashboard';

export const getActiveChannelDocument = graphql(`
    query GetActiveChannelForLoyalty {
        activeChannel {
            id
            code
        }
    }
`);

export const getLoyaltyConfigDocument = graphql(`
    query GetLoyaltyConfig {
        loyaltyPointsConfig {
            id
            rupeesPerPoint
            pointsPerRupee
        }
    }
`);

export const createLoyaltyConfigDocument = graphql(`
    mutation CreateLoyaltyConfig($input: LoyaltyPointsConfigInput!) {
        createLoyaltyPointsConfig(input: $input) {
            id
            rupeesPerPoint
            pointsPerRupee
        }
    }
`);

export const updateLoyaltyConfigDocument = graphql(`
    mutation UpdateLoyaltyConfig($id: ID!, $input: LoyaltyPointsConfigInput!) {
        updateLoyaltyPointsConfig(id: $id, input: $input) {
            id
            rupeesPerPoint
            pointsPerRupee
        }
    }
`);

export const deleteLoyaltyConfigDocument = graphql(`
    mutation DeleteLoyaltyConfig($id: ID!) {
        deleteLoyaltyPointsConfig(id: $id)
    }
`);

export const getReferralConfigDocument = graphql(`
    query GetReferralChannelPoints {
        referralChannelPoints {
            id
            points
        }
    }
`);

export const createReferralConfigDocument = graphql(`
    mutation CreateReferralChannelPoints($input: ReferralChannelPointsInput!) {
        createReferralChannelPoints(input: $input) {
            id
            points
        }
    }
`);

export const updateReferralConfigDocument = graphql(`
    mutation UpdateReferralChannelPoints($id: ID!, $input: ReferralChannelPointsInput!) {
        updateReferralChannelPoints(id: $id, input: $input) {
            id
            points
        }
    }
`);

export const deleteReferralConfigDocument = graphql(`
    mutation DeleteReferralChannelPoints($id: ID!) {
        deleteReferralChannelPoints(id: $id)
    }
`);

export const getReferralsDocument = graphql(`
    query GetReferralsForLoyalty {
        referrals(take: 100) {
            items {
                id
                referralNumber
                createdAt
                status
                points
                referrer {
                    id
                    firstName
                    lastName
                    emailAddress
                }
                referredCustomer {
                    id
                    firstName
                    lastName
                    emailAddress
                }
            }
            totalItems
        }
    }
`);

export interface ReferralCustomer {
    id: string;
    firstName: string;
    lastName: string;
    emailAddress: string;
}

export interface Referral {
    id: string;
    referralNumber: number;
    createdAt: string;
    status: string;
    points: number;
    referrer: ReferralCustomer;
    referredCustomer: ReferralCustomer;
}

export interface LoyaltyConfig {
    id: string;
    rupeesPerPoint: number;
    pointsPerRupee: number;
}

export interface ReferralConfig {
    id: string;
    points: number;
}

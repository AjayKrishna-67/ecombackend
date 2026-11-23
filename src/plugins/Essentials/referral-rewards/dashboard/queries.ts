import { graphql } from '@vendure/dashboard';

export const getReferralSummaryDocument = graphql(`
    query GetReferralSummary {
        referralSummary {
            today {
                totalReferrals
                registered
                eligible
                claimed
            }
            yesterday {
                totalReferrals
                registered
                eligible
                claimed
            }
            allTime {
                totalReferrals
                registered
                eligible
                claimed
            }
        }
    }
`);

export const getCustomerReferredByDocument = graphql(`
    query GetCustomerReferredBy($customerId: ID!) {
        customer(id: $customerId) {
            id
            referredBy {
                id
                status
                points
                createdAt
                referrer {
                    id
                    firstName
                    lastName
                }
            }
        }
    }
`);

export interface ReferralSummary {
    totalReferrals: number;
    registered: number;
    eligible: number;
    claimed: number;
}

export interface ReferralSummaryReport {
    today: ReferralSummary;
    yesterday: ReferralSummary;
    allTime: ReferralSummary;
}

export interface ReferredBy {
    id: string;
    status: string;
    points: number;
    createdAt: string;
    referrer: { id: string; firstName: string; lastName: string };
}

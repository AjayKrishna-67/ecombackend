import { graphql } from '@vendure/dashboard';

export const getDeletionRequestsDocument = graphql(`
    query CustomersWithDeletionRequest($skip: Int, $take: Int) {
        customersWithDeletionRequest(skip: $skip, take: $take) {
            items {
                id
                firstName
                lastName
                phoneNumber
                emailAddress
                reason
                requestedDate
            }
            totalItems
        }
    }
`);

export interface DeletionRequest {
    id: string;
    firstName: string;
    lastName: string;
    phoneNumber: string;
    emailAddress: string;
    reason: string;
    requestedDate: string;
}

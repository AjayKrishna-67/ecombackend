import { graphql } from '@vendure/dashboard';

export const getOrderDeliveryAssignmentsDocument = graphql(`
    query GetOrderDeliveryAssignments($orderId: ID!) {
        orderDeliveryAssignments(orderId: $orderId) {
            fulfillmentId
            state
            deliveryPersonName
            deliveryPersonPhone
            createdAt
        }
    }
`);

export const getDeliveryPersonsDocument = graphql(`
    query GetDeliveryPersons {
        deliveryPersons {
            id
            firstName
            lastName
            phoneNumber
        }
    }
`);

export interface DeliveryAssignment {
    fulfillmentId: string;
    state: string;
    deliveryPersonName: string;
    deliveryPersonPhone: string | null;
    createdAt: string;
}

export interface DeliveryPerson {
    id: string;
    firstName: string;
    lastName: string;
    phoneNumber: string | null;
}

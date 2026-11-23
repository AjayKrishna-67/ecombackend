import { gql } from 'graphql-tag';

/**
 * Shop API Extensions for Price Update Plugin
 * 
 * Extends the activeOrder query to automatically handle price updates
 * for active customers accessing their cart.
 */
export const shopApiExtensions = gql`
    extend type Query {
        activeOrder: Order
    }
`;


import gql from 'graphql-tag';

export const shopApiExtensions = gql`
    extend type Query {
        """
        Get eligible shipping methods that are enabled.
        Returns only shipping methods where the 'enabled' custom field is true.
        Replaces the standard eligibleShippingMethods for filtering disabled methods.
        """
        eligibleShippingMethodsEnabled: [ShippingMethod!]!
    }
`;

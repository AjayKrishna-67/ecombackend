import gql from 'graphql-tag';

/**
 * GraphQL Schema Extensions for Shop API
 *
 * Provides queries to fetch channels based on:
 * - Customer email
 * - Customer phone number
 * - Postal code
 */
export const shopApiExtensions = gql`
    """
    Channel type enumeration
    """
    enum ChannelTypeEnum {
        CITY
        BRAND
        DIRECT
    }

    """
    Customer channel information with custom fields
    """
    type CustomerChannel {
        id: ID!
        code: String!
        token: String!
        name: String!
        type: ChannelTypeEnum!
    }

    extend type Query {
        """
        Get all channels assigned to a customer by email address.
        Returns channels with their token for switching stores.
        Filters out the default channel automatically.
        """
        getChannelsByCustomerEmail(email: String!): [CustomerChannel!]!

        """
        Get all channels assigned to a customer by phone number.
        Returns channels with their token for switching stores.
        Filters out the default channel automatically.
        """
        getChannelsByCustomerPhoneNumber(phoneNumber: String!): [CustomerChannel!]!

        """
        Get all available channels for a given postal code.
        Returns channels that either:
        1. Have this specific postal code assigned
        2. Are set to "Anywhere" mode (serve all postal codes)

        Filters out the default channel automatically.
        Useful for showing available channels/brands when customers
        enter a postal code or order for friends in different locations.
        """
        getChannelsByPostalCode(postalCode: String!): [CustomerChannel!]!
    }
`;

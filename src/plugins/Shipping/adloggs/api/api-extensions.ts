import gql from 'graphql-tag';

export const adminApiExtensions = gql`
    type AdloggsWalletBalance {
        enabled: Boolean!
        balance: String
        message: String
    }

    type AdloggsSyncResult {
        success: Boolean!
        message: String
        statusId: Int
        fulfillmentState: String
    }

    extend type Query {
        """
        Current Adloggs wallet balance for the configured API key.
        enabled=false when the Adloggs account has no wallet.
        """
        adloggsWalletBalance: AdloggsWalletBalance!
    }

    extend type Mutation {
        """
        Reconcile one Adloggs fulfillment with Adloggs: fetches the current
        status and applies it (rider details + fulfillment state). If the
        Adloggs order was never created (earlier failure), retries the creation.
        """
        syncAdloggsStatus(fulfillmentId: ID!): AdloggsSyncResult!
    }
`;

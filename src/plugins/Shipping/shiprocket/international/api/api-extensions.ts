import { gql } from 'graphql-tag';

/** Shared tracking types (duplicated per schema — admin and shop schemas are independent). */
const trackingTypes = `
    type ShiprocketTrackActivity {
        date: String!
        status: String!
        activity: String!
        location: String!
        srStatus: String
        srStatusLabel: String
    }

    type ShiprocketTracking {
        awb: String!
        courierName: String
        currentStatus: String
        etd: String
        trackUrl: String
        activities: [ShiprocketTrackActivity!]!
    }
`;

/**
 * Admin API: refresh a fulfillment's Shiprocket state (`orders/show`) and read live tracking.
 */
export const adminApiExtensions = gql`
    ${trackingTypes}

    type ShiprocketSyncResult {
        success: Boolean!
        message: String
        status: String
        awb: String
        courierName: String
        invoiceUrl: String
        isIncomplete: Boolean
        errors: [String!]!
    }

    """Stored Shiprocket data for one fulfillment (its custom fields are internal, so read here)."""
    type ShiprocketFulfillmentInfo {
        fulfillmentId: ID!
        """Vendure fulfillment state (Pending/Shipped/…/Cancelled) — Cancelled attempts stay listed."""
        state: String
        shiprocketOrderId: String
        """The random numeric order id sent to Shiprocket as channel_order_id."""
        channelOrderId: String
        shipmentId: String
        status: String
        awb: String
        courierName: String
        courierId: String
        trackUrl: String
        invoiceUrl: String
        length: Int
        breadth: Int
        height: Int
        weightGrams: Int
        lastSyncedAt: String
    }

    extend type Mutation {
        """
        Pulls the latest Shiprocket order details for a fulfillment and updates its stored
        status / AWB / courier / invoice link.
        """
        syncShiprocketFulfillment(fulfillmentId: ID!): ShiprocketSyncResult!
    }

    extend type Query {
        """Stored Shiprocket shipment data for each of an order's fulfillments."""
        shiprocketOrderFulfillments(orderId: ID!): [ShiprocketFulfillmentInfo!]!
        """Live tracking timeline for an AWB (proxied to Shiprocket, short-cached)."""
        shiprocketTracking(awb: String!): ShiprocketTracking
    }
`;

/**
 * Shop API: live tracking for the customer's own order, proxied so the Shiprocket token never
 * reaches the storefront. Resolved by looking up the order's fulfillment AWB, then tracking it.
 */
export const shopApiExtensions = gql`
    ${trackingTypes}

    extend type Query {
        """Live Shiprocket tracking for one of the current customer's orders."""
        shiprocketTracking(orderCode: String!): ShiprocketTracking
    }
`;

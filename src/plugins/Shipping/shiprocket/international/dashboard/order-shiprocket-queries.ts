import { graphql } from '@vendure/dashboard';

/** Stored Shiprocket data for an order's fulfillments (custom fields are internal). */
export const shiprocketOrderFulfillmentsDocument = graphql(`
    query ShiprocketOrderFulfillments($orderId: ID!) {
        shiprocketOrderFulfillments(orderId: $orderId) {
            fulfillmentId
            state
            shiprocketOrderId
            channelOrderId
            shipmentId
            status
            awb
            courierName
            courierId
            trackUrl
            length
            breadth
            height
            weightGrams
            lastSyncedAt
        }
    }
`);

/** Refresh a fulfillment from Shiprocket (orders/show) and persist the latest status/AWB. */
export const syncShiprocketFulfillmentDocument = graphql(`
    mutation SyncShiprocketFulfillment($fulfillmentId: ID!) {
        syncShiprocketFulfillment(fulfillmentId: $fulfillmentId) {
            success
            message
            status
            awb
            courierName
            isIncomplete
            errors
        }
    }
`);

/** Live tracking timeline for an AWB (proxied to Shiprocket). */
export const shiprocketTrackingDocument = graphql(`
    query ShiprocketTracking($awb: String!) {
        shiprocketTracking(awb: $awb) {
            awb
            courierName
            currentStatus
            etd
            trackUrl
            activities {
                date
                status
                activity
                location
                srStatus
                srStatusLabel
            }
        }
    }
`);

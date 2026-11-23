import { graphql } from '@vendure/dashboard';
import type { TadaDocumentNode } from 'gql.tada';

/** Live Shiprocket Quick order data for a Vendure order (also auto-syncs fulfillment state server-side). */
// Explicit annotations keep the exported types portable (avoids TS2742 in the
// composite dashboard project — the inferred gql-tada type is not nameable).
export const shiprocketQuickDetailsDocument: TadaDocumentNode<
    any,
    { vendureOrderId: string }
> = graphql(`
    query GetShiprocketDetailsByVendureOrder($vendureOrderId: ID!) {
        getShiprocketDetailsByVendureOrder(vendureOrderId: $vendureOrderId) {
            id
            channel_order_id
            status
            status_code
            pickup_location
            payment_method
            total
            created_at
            order_date
            shipments {
                id
                awb
                courier
                status
                etd
                weight
            }
            products {
                name
                sku
                quantity
                selling_price
            }
        }
    }
`);

/** Live tracking by shipment id — works before the rider/AWB is assigned. */
export const shiprocketQuickTrackingDocument: TadaDocumentNode<
    any,
    { shipmentId: number }
> = graphql(`
    query GetShiprocketQuickTracking($shipmentId: Int!) {
        getShiprocketQuickTracking(shipmentId: $shipmentId) {
            shipmentId
            awb
            courierName
            currentStatus
            origin
            destination
            pickupDate
            deliveredDate
            etd
            trackUrl
            error
            activities {
                date
                status
                activity
                location
                srStatusLabel
            }
        }
    }
`);

/** Assign an AWB / trigger rider assignment for a Quick shipment (Ship Now). */
export const assignShiprocketAwbDocument: TadaDocumentNode<
    any,
    { shipmentId: number; courierId?: number | null }
> = graphql(`
    mutation AssignShiprocketAwb($shipmentId: Int!, $courierId: Int) {
        assignShiprocketAwb(shipmentId: $shipmentId, courierId: $courierId) {
            success
            awb_code
            courier_name
            message
        }
    }
`);

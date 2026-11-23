import { graphql } from '@vendure/dashboard';
import type { TadaDocumentNode } from 'gql.tada';

/** Adloggs data lives on the fulfillment custom fields — one standard order query. */
// Explicit annotations keep the exported types portable (avoids TS2742 in the
// composite dashboard project — the inferred gql-tada type is not nameable).
export const adloggsOrderFulfillmentsDocument: TadaDocumentNode<any, { id: string }> = graphql(`
    query GetAdloggsOrderFulfillments($id: ID!) {
        order(id: $id) {
            id
            fulfillments {
                id
                state
                method
                customFields {
                    adloggsOrderUuid
                    adloggsStatus
                    adloggsTrackUrl
                    adloggsRiderName
                    adloggsRiderPhone
                    adloggsFee
                    adloggsError
                }
            }
        }
    }
`);

/** Pull the current status from Adloggs and apply it (or retry a failed creation). */
export const syncAdloggsStatusDocument: TadaDocumentNode<any, { fulfillmentId: string }> = graphql(`
    mutation SyncAdloggsStatus($fulfillmentId: ID!) {
        syncAdloggsStatus(fulfillmentId: $fulfillmentId) {
            success
            message
            statusId
            fulfillmentState
        }
    }
`);

export const adloggsWalletBalanceDocument: TadaDocumentNode<any, {}> = graphql(`
    query AdloggsWalletBalance {
        adloggsWalletBalance {
            enabled
            balance
            message
        }
    }
`);

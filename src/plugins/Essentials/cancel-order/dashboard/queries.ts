import { graphql } from '@vendure/dashboard';

// Built-in SettingsStore operations — no custom resolver needed. The `cancelOrder.*` keys are
// registered in cancel-order.plugin.ts, which also declares their read/write permissions.
// Both keys are fetched/saved together so the channel list and the shared default list can
// never drift out of sync in the UI.
export const getAlertConfigDocument = graphql(`
    query GetCancelOrderAlertConfig($keys: [String!]!) {
        getSettingsStoreValues(keys: $keys)
    }
`);

export const setAlertConfigDocument = graphql(`
    mutation SetCancelOrderAlertConfig($inputs: [SettingsStoreInput!]!) {
        setSettingsStoreValues(inputs: $inputs) {
            key
            result
            error
        }
    }
`);

// Candidates for the administrator picker. Soft-deleted admins are excluded by the Admin
// API; those without a phone number are filtered client-side so the reason is visible.
export const administratorsDocument = graphql(`
    query CancelOrderAdministrators {
        administrators(options: { take: 200 }) {
            items {
                id
                firstName
                lastName
                emailAddress
                customFields {
                    phoneNumber
                }
            }
        }
    }
`);

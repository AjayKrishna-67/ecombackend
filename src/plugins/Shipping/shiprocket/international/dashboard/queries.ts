import { graphql } from '@vendure/dashboard';

/**
 * Read/write the channel-scoped Shiprocket config via the generic SettingsStore API
 * (no custom resolver needed). The value is the `ShiprocketConfig` JSON blob stored
 * under the `shiprocket.config` key.
 */
export const shiprocketConfigDocument = graphql(`
    query ShiprocketConfig($key: String!) {
        getSettingsStoreValue(key: $key)
    }
`);

export const setShiprocketConfigDocument = graphql(`
    mutation SetShiprocketConfig($input: SettingsStoreInput!) {
        setSettingsStoreValue(input: $input) {
            key
            result
            error
        }
    }
`);

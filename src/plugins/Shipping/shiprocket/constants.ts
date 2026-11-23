// Constants for the Shiprocket shipping-rate plugin.

// Shiprocket v2 REST API base URL. Endpoints append their own paths
// (e.g. /v1/external/auth/login, /v1/external/courier/serviceability/).
export const SHIPROCKET_API_URL = 'https://apiv2.shiprocket.in';

// DI injection token used to provide PluginInitOptions to the ShipRocket service.
export const SHIPROCKET_PLUGIN_OPTIONS = Symbol('SHIPROCKET_PLUGIN_OPTIONS');

// Logger context tag so Shiprocket log lines are grep-able.
export const loggerCtx = 'ShiprocketPlugin';

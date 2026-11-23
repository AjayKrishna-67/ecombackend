// Constants for the Adloggs hyperlocal delivery plugin.

// DI injection token used to provide PluginInitOptions to the Adloggs services.
export const ADLOGGS_PLUGIN_OPTIONS = Symbol('ADLOGGS_PLUGIN_OPTIONS');

// Logger context tag so Adloggs log lines are grep-able.
export const loggerCtx = 'AdloggsPlugin';

// fulfillmentType value stamped by the KaaiKani fulfillment handler.
export const ADLOGGS_FULFILLMENT_TYPE = 'adloggs';

// Header Adloggs must send on webhook calls (value = ADLOGGS_WEBHOOK_TOKEN env).
export const ADLOGGS_WEBHOOK_TOKEN_HEADER = 'x-webhook-token';

export const WHATSAPP_PLUGIN_OPTIONS = Symbol('WHATSAPP_PLUGIN_OPTIONS');
export const loggerCtx = 'WhatsappPlugin';
export const DEFAULT_GRAPH_API_VERSION = 'v25.0';

/** Name of the shop AuthenticationStrategy → GraphQL input field `authenticate(input: { whatsapp: … })`. */
export const STRATEGY_WHATSAPP = 'whatsapp';
/**
 * An order counts as "placed via WhatsApp" only if its session logged in through
 * a WhatsApp link this recently. Meta allows free-form messages only within 24h
 * of the customer's last message to us; the link itself expires 30 min after
 * that message, so 23h keeps the confirmation safely inside the window.
 */
export const WHATSAPP_ORDER_WINDOW_MS = 23 * 60 * 60_000;
/** Storefront page listing the customer's orders (the "View order" button). */
export const ORDERS_PATH = '/account/history';
/** Storefront route that redeems a login link. */
export const LOGIN_PATH = '/auth/whatsapp';
/** `origin` Meta sets on a contact the user shared by tapping our REQUEST_CONTACT_INFO button. */
export const CONTACT_REQUEST_ORIGIN = 'contact_request';
/**
 * Reacting to our card or a WhatsApp system notice (e.g. number change) must
 * not trigger another card/login link.
 */
export const IGNORED_MESSAGE_TYPES: readonly string[] = ['reaction', 'system', 'unsupported'];
/** Reply-button ids of the support menu (see WhatsappBrand.supportMenu). */
export const MENU_ORDER_ID = 'menu_order';
export const MENU_SUPPORT_ID = 'menu_support';
/** Reply-button ids of the support options shown after a Support tap. */
export const SUPPORT_CHAT_ID = 'support_chat';
export const SUPPORT_CALL_ID = 'support_call';

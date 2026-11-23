/**
 * Shared constants for the GoodsTransferPlugin.
 * (TDS §3 — Goods Transfer & Damage Management System)
 */
export const loggerCtx = 'GoodsTransferPlugin';

/**
 * How far back alerts reach when the client sends no `alertsAfterId`.
 *
 * Short on purpose. A screen opening fresh should show what just happened, not a
 * backlog — an alert is a nudge, and the list screens are where history lives. A
 * client that wants to miss nothing sends the timestamp of the last alert it showed.
 */
export const ALERT_DEFAULT_WINDOW_MINUTES = 15;

/**
 * Ceiling on alerts returned in one response. A screen that has been closed for a
 * week should not open into two hundred toasts; past that, the list is the answer.
 */
export const ALERT_MAX_ITEMS = 20;

/**
 * A stocked item is flagged when it has used up this share of its shelf life,
 * e.g. 80% of a 10-day product = day 8. Indicator only — never blocks stock.
 */
export const EXPIRY_WARNING_THRESHOLD_PCT = 80;

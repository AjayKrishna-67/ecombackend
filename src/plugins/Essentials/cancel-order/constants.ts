import { CancelOrderAlertConfig } from './types';

// SettingsStore keys. Both hold the same JSON shape; they differ only in scope
// (see cancel-order.plugin.ts). Channel wins over default; default wins over env/seed.
export const CANCEL_ORDER_ALERT_KEY = 'cancelOrder.alertConfig';
export const CANCEL_ORDER_DEFAULT_ALERT_KEY = 'cancelOrder.defaultAlertConfig';

/**
 * Last-resort seed values, used only until an admin saves the default list on the Global
 * Settings page. These are the numbers that were previously hardcoded in Msg91Service; env
 * vars (MSG91_HELLO_NUMBER / MSG91_SUPPORT_NUMBERS) still override them for a fresh install.
 */
export const DEFAULT_CANCEL_ORDER_ALERT_CONFIG: CancelOrderAlertConfig = {
    helloNumber: '919894681385',
    supportNumbers: ['916380774767', '916379993190', '917868000215', '917845847259'],
    adminIds: [],
};

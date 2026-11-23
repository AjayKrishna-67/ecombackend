import { AbandonedCartConfig } from './types';

// SettingsStore key. Stored as one channel-scoped JSON object (see plugin config).
export const ABANDONED_CART_SETTING_KEY = 'abandonedCart.config';

// Stage delays default to 12 hours / 3 days / 7 days (locked in brainstorm).
export const DEFAULT_ABANDONED_CART_CONFIG: AbandonedCartConfig = {
    enabled: false,
    minOrderValueMinor: null, // empty = hard guard, NO sends until admin sets a real floor
    costPerMessageMinor: 0, // ₹0 by default; set the real MSG91 per-message rate to enable ROI
    stages: [
        { delayValue: 12, delayUnit: 'hours', templateName: '', language: 'en', bodyVars: [], headerImageUrl: '', buttonUrlParam: '' },
        { delayValue: 3, delayUnit: 'days', templateName: '', language: 'en', bodyVars: [], headerImageUrl: '', buttonUrlParam: '' },
        { delayValue: 7, delayUnit: 'days', templateName: '', language: 'en', bodyVars: [], headerImageUrl: '', buttonUrlParam: '' },
    ],
};

// Tokens admins may map to a body_{n} slot; anything else is treated as static text.
export const SUPPORTED_TOKENS = ['{customerName}', '{firstName}', '{orderCode}', '{cartTotal}'] as const;

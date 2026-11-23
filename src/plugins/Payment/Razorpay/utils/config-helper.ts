// src/plugins/Payment/Razorpay/utils/config-helper.ts

import { PaymentMethod } from '@vendure/core';

export interface RazorpayConfig {
    key_id: string;
    key_secret: string;
    webhook_enabled: boolean;
    webhook_url?: string;
    webhook_secret?: string;
}

/**
 * Extract Razorpay configuration from payment method args
 * Handles both old format (individual args) and new format (nested config object)
 */
export function getRazorpayConfig(paymentMethod: PaymentMethod): RazorpayConfig | null {
    const args = paymentMethod.handler.args;
    
    // Check for new format (config object)
    const configArg = args.find(a => a.name === 'config');
    if (configArg?.value) {
        try {
            const config = typeof configArg.value === 'string' 
                ? JSON.parse(configArg.value) 
                : configArg.value;
            return config as RazorpayConfig;
        } catch (e) {
            console.error('Failed to parse Razorpay config:', e);
        }
    }
    
    // Fallback to old format (individual args) for backward compatibility
    const keyIdArg = args.find(a => a.name === 'key_id');
    const keySecretArg = args.find(a => a.name === 'key_secret');
    const webhookEnabledArg = args.find(a => a.name === 'webhook_enabled');
    const webhookUrlArg = args.find(a => a.name === 'webhook_url');
    const webhookSecretArg = args.find(a => a.name === 'webhook_secret');
    
    if (keyIdArg?.value && keySecretArg?.value) {
        const webhookEnabledValue = webhookEnabledArg?.value;
        const isWebhookEnabled = String(webhookEnabledValue).toLowerCase() === 'true';
        
        return {
            key_id: keyIdArg.value,
            key_secret: keySecretArg.value,
            webhook_enabled: isWebhookEnabled,
            webhook_url: webhookUrlArg?.value,
            webhook_secret: webhookSecretArg?.value,
        };
    }
    
    return null;
}


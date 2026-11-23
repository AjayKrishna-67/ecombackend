import { PageContextValue, Switch } from '@vendure/dashboard';
import React from 'react';

/**
 * Side-column block for the Channel `enabled` custom field, mirroring the
 * ShippingMethod enabled toggle. Bound to the same react-hook-form value, so it
 * persists with the channel-detail page's Update button (no separate mutation).
 */
export function ChannelEnabledBlock({ context }: { context: PageContextValue }) {
    const form = context.form;
    if (!form) {
        return null;
    }
    const value = form.watch('customFields.enabled');
    const enabled = value !== false; // custom field defaults to true
    return (
        <div className="space-y-2">
            <Switch
                checked={enabled}
                onCheckedChange={checked =>
                    form.setValue('customFields.enabled', checked, { shouldDirty: true, shouldTouch: true })
                }
            />
            <p className="text-muted-foreground text-sm">
                {enabled
                    ? 'This channel is enabled for customer access.'
                    : 'This channel is disabled and hidden from customers.'}
            </p>
        </div>
    );
}

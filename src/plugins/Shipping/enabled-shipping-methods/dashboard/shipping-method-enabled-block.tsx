import { PageContextValue, Switch } from '@vendure/dashboard';
import React from 'react';

/**
 * Side-column block for the ShippingMethod `enabled` custom field, styled like
 * the core Collection "Private" toggle. Bound to the same form value, so it
 * saves with the page's Update button.
 */
export function ShippingMethodEnabledBlock({ context }: { context: PageContextValue }) {
    const form = context.form;
    if (!form) {
        return null;
    }
    const value = form.watch('customFields.enabled');
    const enabled = value !== false;
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
                    ? 'This shipping method is available for orders.'
                    : 'This shipping method is disabled and hidden from orders.'}
            </p>
        </div>
    );
}

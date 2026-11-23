import { DashboardFormComponent, Switch } from '@vendure/dashboard';
import React from 'react';

/**
 * Custom-field input for `ShippingMethod.enabled`. Renders a toggle switch
 * (with an Enabled/Disabled label) in place of the default boolean checkbox.
 * Registered against the custom field's `ui.component: 'app-shipping-method-toggle'`.
 */
export const ShippingMethodToggle: DashboardFormComponent = ({ value, onChange, disabled }) => {
    const enabled = value !== false; // custom field defaults to true
    return (
        <div className="flex items-center gap-2">
            <Switch
                checked={enabled}
                disabled={disabled}
                onCheckedChange={checked => onChange?.(checked)}
            />
            <span className={enabled ? 'text-foreground text-sm' : 'text-muted-foreground text-sm'}>
                {enabled ? 'Enabled' : 'Disabled'}
            </span>
        </div>
    );
};

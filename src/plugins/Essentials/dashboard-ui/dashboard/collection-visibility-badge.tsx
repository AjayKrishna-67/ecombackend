import { BooleanDisplayBadge } from '@vendure/dashboard';
import React from 'react';

/**
 * Renders the Collection list `isPrivate` column as an Enabled/Disabled badge
 * instead of the default check/cross icons.
 *
 * The underlying field is inverted: `isPrivate === true` means the collection is
 * hidden from the storefront, so it is displayed as "Disabled".
 */
export function CollectionVisibilityBadge({ value }: Readonly<{ value: boolean }>) {
    return <BooleanDisplayBadge value={!value} labelTrue="Enabled" labelFalse="Disabled" />;
}

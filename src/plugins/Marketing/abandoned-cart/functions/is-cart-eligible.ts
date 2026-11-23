import { EligibilityInput } from '../types';

/** True when an order qualifies for an abandoned-cart nudge. */
export function isCartEligible(input: EligibilityInput): boolean {
    return (
        input.state === 'AddingItems' &&
        Boolean(input.phoneNumber) &&
        input.minOrderValueMinor != null &&
        input.totalWithTax > input.minOrderValueMinor
    );
}

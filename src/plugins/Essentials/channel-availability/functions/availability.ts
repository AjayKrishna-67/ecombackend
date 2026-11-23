export type ChannelLaunchStatus = 'OPENING_SOON' | 'LAUNCHED';

const INTERNATIONAL_TYPE = 'INTERNATIONAL';
const DOMESTIC_COUNTRY = 'IN';

/**
 * True when the customer is ordering from OUTSIDE India: a country is given and
 * it is not "IN" (case/space-insensitive). Absent country = domestic (the app is
 * India-first). "IN" or "ID" or "us" all normalise the same way as their input.
 */
export function isInternationalRegion(country?: string): boolean {
    return !!country && country.trim().toUpperCase() !== DOMESTIC_COUNTRY;
}

/**
 * Does a channel's free-text `type` match the customer's region?
 * Outside India → keep ONLY channels typed "International". Inside India → keep
 * every channel EXCEPT "International". Comparison is case-insensitive; the `type`
 * is admin free-text so an exact match on "INTERNATIONAL" is required.
 */
export function typeMatchesRegion(channelType: string | null | undefined, country?: string): boolean {
    const type = (channelType ?? '').toString().toUpperCase();
    return isInternationalRegion(country) ? type === INTERNATIONAL_TYPE : type !== INTERNATIONAL_TYPE;
}

/**
 * Is this channel's free-text `type` the "International" one? Region-agnostic
 * (no country arg) — answers only "does this brand have an overseas channel",
 * which the switcher uses to decide whether to show the country toggle.
 */
export function isInternationalType(channelType: string | null | undefined): boolean {
    return (channelType ?? '').toString().trim().toUpperCase() === INTERNATIONAL_TYPE;
}

export interface AvailabilityDecision {
    isAvailable: boolean;
    message?: string;
    /** Whether the entry token should be exposed to the client. */
    hasToken: boolean;
}

/**
 * The core availability decision, independent of DB entities so it can be unit
 * tested. Three ordered gates:
 *   1. launchStatus OPENING_SOON → locked (token dropped) regardless of pincode.
 *   2. pincode serves → available, token exposed.
 *   3. else → CITY stays listed as "Available" and KEEPS its token (app decides);
 *      any other type is "Brand will available soon" and DROPS its token.
 */
export function decideAvailability(params: {
    channelType: string;
    launchStatus: ChannelLaunchStatus;
    postalCodeAvailable: boolean;
}): AvailabilityDecision {
    const { channelType, launchStatus, postalCodeAvailable } = params;
    if (launchStatus === 'OPENING_SOON') {
        return { isAvailable: false, message: 'Opening soon', hasToken: false };
    }
    if (postalCodeAvailable) {
        return { isAvailable: true, message: undefined, hasToken: true };
    }
    return channelType === 'CITY'
        ? { isAvailable: false, message: 'Available', hasToken: true }
        : { isAvailable: false, message: 'Brand will available soon', hasToken: false };
}

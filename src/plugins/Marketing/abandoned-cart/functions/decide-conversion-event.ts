/**
 * Pure decision for recording a cart conversion. Given whether the placed order was nudged, how
 * many stages it received, and whether a conversion was already logged, returns the stage to record
 * (the stage the customer ordered at = messages already sent) or null to skip. Keeps the
 * attribution + idempotency logic testable without a DB.
 */
export interface ConversionInput {
    hasNudge: boolean;
    stagesSent: number;
    alreadyConverted: boolean;
}

export function decideConversionEvent(input: ConversionInput): { stage: number } | null {
    if (!input.hasNudge || input.alreadyConverted) {
        return null;
    }
    return { stage: input.stagesSent };
}

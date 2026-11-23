/**
 * Recency-based customer segment states.
 *
 * Buckets (let X = activeWithinDays, Y = atRiskUntilDays, Y > X):
 *
 *   days === null   -> NEVER     (no qualifying order)
 *   days <= X       -> ACTIVE
 *   X < days <= Y   -> AT_RISK
 *   days > Y        -> CHURN
 */
export type CustomerSegmentState = 'ACTIVE' | 'AT_RISK' | 'CHURN' | 'NEVER';

/**
 * Two independent day thresholds that define the recency buckets. Stored per
 * channel in the SettingsStore and echoed to the UI.
 */
export interface RecencyThresholds {
    activeWithinDays: number;
    atRiskUntilDays: number;
}

/**
 * Validates the recency thresholds. The invariant `atRiskUntilDays > activeWithinDays`
 * keeps the AT_RISK band non-empty; both values must be non-negative day counts.
 * Throws so a misconfiguration is caught at config-read time, not silently swallowed
 * into a degenerate (empty AT_RISK) classification.
 */
export function assertValidThresholds(thresholds: RecencyThresholds): void {
    const { activeWithinDays, atRiskUntilDays } = thresholds;
    if (activeWithinDays < 0 || atRiskUntilDays < 0) {
        throw new Error('Recency thresholds must be non-negative day counts.');
    }
    if (atRiskUntilDays <= activeWithinDays) {
        throw new Error('atRiskUntilDays must be greater than activeWithinDays.');
    }
}

/**
 * Maps days-since-last-order to a segment state. `daysSinceLastOrder` is null when
 * the customer has no qualifying order (NEVER bucket). Pure and total: the single
 * source of bucket math shared by the SQL CASE and any app-side label so summary
 * counts and list membership never diverge.
 */
export function classifyRecency(
    daysSinceLastOrder: number | null,
    thresholds: RecencyThresholds,
): CustomerSegmentState {
    if (daysSinceLastOrder === null) {
        return 'NEVER';
    }
    if (daysSinceLastOrder <= thresholds.activeWithinDays) {
        return 'ACTIVE';
    }
    if (daysSinceLastOrder <= thresholds.atRiskUntilDays) {
        return 'AT_RISK';
    }
    return 'CHURN';
}

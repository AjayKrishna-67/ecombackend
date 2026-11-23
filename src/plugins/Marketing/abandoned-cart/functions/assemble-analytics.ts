import { AbandonedCartAnalytics, StageCount } from '../types';

const STAGES = [1, 2, 3] as const;

/** One row of a SQL `GROUP BY eventType, stage` aggregation over the event log. */
export interface EventStageCount {
    eventType: string;
    stage: number;
    count: number;
}

function bucketByStage(rows: EventStageCount[], eventType: string): StageCount[] {
    return STAGES.map(stage => ({
        stage,
        count: rows.find(r => r.eventType === eventType && r.stage === stage)?.count ?? 0,
    }));
}

/**
 * Assembles the analytics summary from pre-aggregated SQL inputs (kept pure so the math is
 * unit-tested even though the heavy counting now happens in the database). `distinctNudgedCarts`
 * and `avgTimeToOrderSeconds` come from dedicated aggregate queries; both default to 0 upstream
 * when their denominator is empty.
 */
export function assembleAnalytics(args: {
    rows: EventStageCount[];
    distinctNudgedCarts: number;
    avgTimeToOrderSeconds: number;
    revenueRecoveredMinor: number;
    costPerMessageMinor: number;
}): AbandonedCartAnalytics {
    const sentByStage = bucketByStage(args.rows, 'sent');
    const conversionsByStage = bucketByStage(args.rows, 'converted');
    const totalSent = sentByStage.reduce((sum, s) => sum + s.count, 0);
    const conversions = conversionsByStage.reduce((sum, s) => sum + s.count, 0);
    const conversionRate = args.distinctNudgedCarts === 0 ? 0 : conversions / args.distinctNudgedCarts;
    const totalCostMinor = totalSent * args.costPerMessageMinor;
    const roi = totalCostMinor === 0 ? 0 : args.revenueRecoveredMinor / totalCostMinor;
    return {
        totalSent,
        sentByStage,
        conversions,
        conversionsByStage,
        conversionRate,
        avgTimeToOrderSeconds: args.avgTimeToOrderSeconds,
        revenueRecoveredMinor: args.revenueRecoveredMinor,
        totalCostMinor,
        roi,
    };
}

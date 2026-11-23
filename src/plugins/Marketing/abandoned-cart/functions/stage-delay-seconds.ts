import { AbandonedCartStage, DelayUnit } from '../types';

export const UNIT_SECONDS: Record<DelayUnit, number> = {
    seconds: 1,
    hours: 3600,
    days: 86400,
};

/** Converts a stage's delay (value + unit) to seconds, for unit-agnostic comparison. */
export function stageDelaySeconds(stage: AbandonedCartStage): number {
    return stage.delayValue * UNIT_SECONDS[stage.delayUnit];
}

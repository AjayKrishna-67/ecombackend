import { AbandonedCartConfig } from '../types';

const VALID_UNITS = ['seconds', 'hours', 'days'];

/**
 * Throws a plain Error if the config is invalid. Rules: 3 stages; non-negative min value; each
 * stage has a valid unit, a positive delayValue, and (when enabled) a templateName.
 *
 * Delays are GAP-based (each is the wait after the previous send), so they need NOT be ascending —
 * any positive per-stage gap is valid.
 */
export function validateAbandonedCartConfig(config: AbandonedCartConfig): void {
    if (config.minOrderValueMinor != null && config.minOrderValueMinor < 0) {
        throw new Error('minOrderValueMinor must be >= 0 or null');
    }
    if (config.costPerMessageMinor < 0) {
        throw new Error('costPerMessageMinor must be >= 0');
    }
    if (config.stages.length !== 3) {
        throw new Error('exactly 3 stages required');
    }
    config.stages.forEach((stage, index) => {
        if (!VALID_UNITS.includes(stage.delayUnit)) {
            throw new Error(`stage ${index + 1} delayUnit must be one of ${VALID_UNITS.join(', ')}`);
        }
        if (stage.delayValue <= 0) {
            throw new Error(`stage ${index + 1} delayValue must be positive`);
        }
        if (config.enabled && stage.templateName.trim().length === 0) {
            throw new Error(`stage ${index + 1} templateName required when enabled`);
        }
    });
}

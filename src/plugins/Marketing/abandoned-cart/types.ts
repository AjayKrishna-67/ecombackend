export type BodyVarKind = 'static' | 'token';

export interface BodyVar {
    kind: BodyVarKind;
    value: string;
}

export type DelayUnit = 'seconds' | 'hours' | 'days';

export interface AbandonedCartStage {
    delayValue: number;
    delayUnit: DelayUnit;
    templateName: string;
    language: string;
    bodyVars: BodyVar[];
    headerImageUrl?: string;
    buttonUrlParam?: string;
}

export interface AbandonedCartConfig {
    enabled: boolean;
    /** Floor in minor units. null/empty = hard guard: NO cart qualifies (no sends). */
    minOrderValueMinor: number | null;
    /** Cost of one WhatsApp send in minor units (paise), used for ROI. 0 disables cost/ROI. */
    costPerMessageMinor: number;
    stages: AbandonedCartStage[];
}

export interface SendWhatsappArgs {
    phone: string;
    templateName: string;
    language: string;
    vars: Record<string, { type: 'text'; value: string }>;
    headerImageUrl?: string;
    buttonUrlValue?: string;
}

export interface EligibilityInput {
    state: string;
    phoneNumber?: string | null;
    totalWithTax: number;
    minOrderValueMinor: number | null;
}

export type AbandonedCartEventType = 'sent' | 'converted';

export interface StageCount {
    stage: number;
    count: number;
}

export interface AbandonedCartAnalytics {
    totalSent: number;
    sentByStage: StageCount[];
    conversions: number;
    conversionsByStage: StageCount[];
    conversionRate: number;
    avgTimeToOrderSeconds: number;
    /** Sum of placed-order totals attributed to nudged carts (minor units). */
    revenueRecoveredMinor: number;
    /** totalSent * costPerMessageMinor (minor units). */
    totalCostMinor: number;
    /** revenueRecoveredMinor / totalCostMinor; 0 when cost is 0. */
    roi: number;
}

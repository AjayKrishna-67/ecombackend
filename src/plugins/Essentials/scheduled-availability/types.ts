import { ID } from '@vendure/core';
import {
    AvailabilityAction,
    AvailabilityScheduleMode,
    AvailabilityTargetType,
    ReportDateRangeMode,
    ScheduledReportType,
    ScheduleKind,
} from './constants';

/**
 * Shared input shapes for the service and the admin resolver. Kept separate
 * from the service so the resolver can import them without pulling in the
 * service's dependency graph.
 */
export interface CreateAvailabilityScheduleInput {
    /** Defaults to AVAILABILITY when omitted, so older callers keep working. */
    kind?: ScheduleKind | null;
    /** Required for AVAILABILITY, forbidden for REPORT. */
    targetType?: AvailabilityTargetType | null;
    /** Required for AVAILABILITY, forbidden for REPORT. */
    targetId?: ID | null;
    channelId: ID;
    mode: AvailabilityScheduleMode;
    runAt?: Date | null;
    action?: AvailabilityAction | null;
    disableCron?: string | null;
    enableCron?: string | null;
    /** REPORT only. A report has one pattern, not a hide/show pair. */
    sendCron?: string | null;
    reportType?: ScheduledReportType | null;
    /** REPORT only. Brand the report aggregates, not the channel that owns the rule. */
    reportSellerId?: ID | null;
    recipients?: string[] | null;
    dateRangeMode?: ReportDateRangeMode | null;
    timezone?: string | null;
    activeFrom?: Date | null;
    activeUntil?: Date | null;
    label?: string | null;
}

export interface UpdateAvailabilityScheduleInput
    extends Partial<Omit<CreateAvailabilityScheduleInput, 'channelId'>> {
    id: ID;
}

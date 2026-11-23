import * as path from 'path';
import { ReportsPlugin } from '../../Reports/reports.plugin';
import {
    Permission,
    PluginCommonModule,
    SettingsStoreScopeFunction,
    VendurePlugin,
} from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import { adminApiExtensions } from './api/api-extensions';
import { AvailabilityScheduleAdminResolver } from './api/availability-schedule-admin.resolver';
import { AvailabilityScheduleRun } from './entities/availability-schedule-run.entity';
import { AvailabilitySchedule } from './entities/availability-schedule.entity';
import { AvailabilityTargetChangeLog } from './entities/availability-target-change-log.entity';
import { AvailabilityChangeLogService } from './services/availability-change-log.service';
import { AvailabilityScheduleService } from './services/availability-schedule.service';
import { ReportSenderService } from './services/report-sender.service';
import { ReportStorageService } from './services/report-storage.service';
import { TargetApplierRegistry } from './services/target-applier.registry';
import { availabilitySweepTask } from './tasks/availability-sweep.task';
import { reportPruneTask } from './tasks/report-prune.task';
import { MARKET_CLOSURE_SETTING_KEY } from './constants';

/**
 * Market closures are a property of the brand, not the city: one Kaaikani entry
 * covers Madurai, Salem, Coimbatore, Trichy, Kochi and Coimbatore zone 2.
 *
 * `sellerId` is optional on Channel, so a channel with no seller falls back to a
 * single shared bucket rather than throwing. That bucket is harmless -- it starts
 * empty, and an empty calendar means "never closed".
 */
const brandScope: SettingsStoreScopeFunction = ({ ctx }) => String(ctx.channel?.sellerId ?? '');

/**
 * Lets a SuperAdmin schedule products and collections to be enabled or disabled
 * at a future moment, or on a recurring window, per channel.
 *
 * A single worker-side ScheduledTask ticks every minute: it reclaims runs
 * abandoned by a killed worker, materialises future occurrences from
 * user-authored rules into concrete run rows, then atomically claims the due
 * ones and applies them through the relevant Vendure service.
 */
@VendurePlugin({
    // ReportsPlugin exports PurchaseListService: the report is generated
    // in-process by this worker, not fetched over HTTP from itself.
    imports: [PluginCommonModule, ReportsPlugin],
    entities: [AvailabilitySchedule, AvailabilityScheduleRun, AvailabilityTargetChangeLog],
    providers: [
        AvailabilityChangeLogService,
        TargetApplierRegistry,
        ReportSenderService,
        ReportStorageService,
        AvailabilityScheduleService,
    ],
    exports: [AvailabilityScheduleService],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [AvailabilityScheduleAdminResolver],
    },
    configuration: config => {
        config.schedulerOptions.tasks.push(availabilitySweepTask, reportPruneTask);
        config.settingsStoreFields = config.settingsStoreFields ?? {};
        config.settingsStoreFields.marketClosure = [
            {
                name: 'config',
                scope: brandScope,
                requiresPermission: { read: Permission.SuperAdmin, write: Permission.SuperAdmin },
            },
        ];
        return config;
    },
    dashboard: './dashboard/index.tsx',
    compatibility: '^3.6.3',
})
export class ScheduledAvailabilityPlugin {
    /**
     * Angular Admin UI surface, alongside the React `dashboard` entry above.
     *
     * Both frontends are live in this project, so a plugin screen that exists in
     * only one of them is invisible to whichever half of the team uses the
     * other. This one is read-only by design -- see ui/routes.ts.
     *
     * Registering this static is only half the wiring: it must also be pushed
     * into the `extensions` array in src/compile-admin-ui.ts, or the compiler
     * never sees it.
     */
    static UiExtensions: AdminUiExtension = {
        id: 'scheduled-availability',
        extensionPath: path.join(__dirname, 'ui'),
        routes: [{ route: 'scheduled-availability', filePath: 'routes.ts' }],
        providers: ['providers.ts'],
    };
}

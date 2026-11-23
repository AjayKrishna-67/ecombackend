import { APP_INTERCEPTOR } from '@nestjs/core';
import { LanguageCode, PluginCommonModule, VendurePlugin } from '@vendure/core';
import { adminApiExtensions } from './api/api-extensions';
import { AdminActivityLogResolver } from './api/admin-activity-log.resolver';
import { AdminActivityLog } from './entities/admin-activity-log.entity';
import { AdminActivityInterceptor } from './interceptors/admin-activity.interceptor';
import { adminActivityLogPermission } from './permissions';
import { ActivityLogPruneService } from './services/activity-log-prune.service';
import { ActivityLogWriterService } from './services/activity-log-writer.service';
import { AdminActivityLogService } from './services/admin-activity-log.service';
import { SessionActivityService } from './services/session-activity.service';
import { AuthActivitySubscriber } from './subscribers/auth-activity.subscriber';
import { activityLogPruneTask } from './tasks/activity-log-prune.task';

/**
 * Attributes every administrator action on the Admin API to a named person,
 * device and working session.
 *
 * The capture point is a global `APP_INTERCEPTOR` rather than EventBus
 * subscribers, because this project's ~40 custom plugins publish no
 * `VendureEntityEvent` at all — an event-based audit would miss every price
 * matrix save, stock update and postal code edit without raising an error. The
 * interceptor also records failed mutations and failed logins, which no event
 * can express.
 *
 * Session custom fields carry device identity. `Session` already implements
 * `HasCustomFields`, so this costs three columns rather than a second table, and
 * `lastSeenAt` is what makes the session data meaningful given that
 * `sessionDuration` is unset and therefore defaults to one year.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [AdminActivityLog],
    providers: [
        ActivityLogWriterService,
        AdminActivityLogService,
        ActivityLogPruneService,
        SessionActivityService,
        AuthActivitySubscriber,
        {
            provide: APP_INTERCEPTOR,
            useClass: AdminActivityInterceptor,
        },
    ],
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [AdminActivityLogResolver],
    },
    dashboard: './dashboard/index.tsx',
    configuration: config => {
        config.authOptions.customPermissions.push(adminActivityLogPermission);
        config.schedulerOptions.tasks.push(activityLogPruneTask);
        config.customFields.Session = config.customFields.Session || [];
        config.customFields.Session.push(
            {
                name: 'userAgent',
                type: 'string',
                length: 512,
                nullable: true,
                public: false,
                readonly: true,
                label: [{ languageCode: LanguageCode.en, value: 'User agent' }],
            },
            {
                name: 'ipAddress',
                type: 'string',
                nullable: true,
                public: false,
                readonly: true,
                label: [{ languageCode: LanguageCode.en, value: 'IP address' }],
            },
            {
                name: 'lastSeenAt',
                type: 'datetime',
                nullable: true,
                public: false,
                readonly: true,
                label: [{ languageCode: LanguageCode.en, value: 'Last seen at' }],
            },
        );
        return config;
    },
    compatibility: '^3.6.3',
})
export class AdminActivityLogPlugin {}

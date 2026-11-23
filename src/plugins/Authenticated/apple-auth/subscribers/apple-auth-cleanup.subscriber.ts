import {
    EventSubscriber,
    EntitySubscriberInterface,
    UpdateEvent,
    DataSource,
} from 'typeorm';
import { User, Logger } from '@vendure/core';
import { Injectable } from '@nestjs/common';

const loggerCtx = 'AppleAuthCleanupSubscriber';

/**
 * Listens for User soft-delete events and removes the Apple
 * ExternalAuthenticationMethod record (the Apple sub) for that user.
 *
 * This ensures that when a Vendure account is deleted, the next Apple sign-in
 * for the same Apple ID treats the user as brand-new and creates a fresh account.
 */
@Injectable()
@EventSubscriber()
export class AppleAuthCleanupSubscriber implements EntitySubscriberInterface<User> {
    constructor(dataSource: DataSource) {
        dataSource.subscribers.push(this);
    }

    listenTo() {
        return User;
    }

    async afterUpdate(event: UpdateEvent<User>): Promise<void> {
        // Only act when deletedAt is being set (account is being soft-deleted)
        const deletedAt = event.entity?.deletedAt;
        const userId = event.entity?.id ?? event.databaseEntity?.id;

        if (!deletedAt || !userId) return;

        try {
            const result = await event.manager
                .createQueryBuilder()
                .delete()
                .from('authentication_method')
                .where('userId = :userId AND strategy = :strategy', {
                    userId,
                    strategy: 'apple',
                })
                .execute();

            if ((result.affected ?? 0) > 0) {
                Logger.info(
                    `[Apple] Removed ${result.affected} authentication_method record(s) for deleted user id=${userId}`,
                    loggerCtx,
                );
            }
        } catch (err) {
            Logger.warn(
                `[Apple] Failed to clean up authentication_method for user id=${userId}: ${err}`,
                loggerCtx,
            );
        }
    }
}

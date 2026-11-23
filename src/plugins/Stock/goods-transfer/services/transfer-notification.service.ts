import { Injectable } from '@nestjs/common';
import { ID, RequestContext, TransactionalConnection } from '@vendure/core';

import { ALERT_DEFAULT_WINDOW_MINUTES, ALERT_MAX_ITEMS } from '../constants';
import { TransferNotification } from '../entities/transfer-notification.entity';
import { NotificationRefType, TransferNotificationType } from '../types';
import { PushSenderService } from './push-sender.service';

/**
 * In-app notifications for the Goods Transfer module — the notification section
 * inside the app, nothing else. No SMS, no WhatsApp, no external messaging.
 *
 * Rows are written INSIDE the business transaction (notifyChannel), so a
 * notification can never exist for an action that rolled back. The bell list
 * shows recent items only (latest 100 within 90 days); rows are never deleted, so
 * the Notification History report stays complete.
 */
@Injectable()
export class TransferNotificationService {
    constructor(
        private connection: TransactionalConnection,
        private pushSender: PushSenderService,
    ) {}

    /**
     * Writes the notification row — call INSIDE the business transaction.
     *
     * The same row is delivered two ways from here, and there is only ever one row:
     * the app turns it into a toast when it is open, and a browser notification is
     * pushed for when it is not. Push is attempted after the row is written and its
     * failures are never awaited — a confirm must not roll back because a browser
     * has stopped listening.
     */
    async notifyChannel(
        ctx: RequestContext,
        input: {
            recipientChannelId: ID;
            type: TransferNotificationType;
            title: string;
            refType: NotificationRefType;
            refId: ID;
            userName: string;
            transferNumber?: string | null;
            productName?: string | null;
            expiresAt?: Date | null;
        },
    ): Promise<TransferNotification> {
        const saved = await this.connection.getRepository(ctx, TransferNotification).save(
            new TransferNotification({
                recipientChannelId: input.recipientChannelId,
                type: input.type,
                title: input.title,
                refType: input.refType,
                refId: input.refId,
                userName: input.userName,
                transferNumber: input.transferNumber ?? null,
                productName: input.productName ?? null,
                expiresAt: input.expiresAt ?? null,
            }),
        );

        // No ctx: the send outlives this transaction by design, and carrying the
        // request's transaction into it is what stopped dead subscriptions ever being
        // cleaned up. See the note at the top of PushSenderService.
        void this.pushSender
            .send(input.recipientChannelId, {
                title: input.title,
                body: input.transferNumber ?? input.productName ?? '',
                refType: input.refType,
                refId: input.refId,
            })
            .catch(() => {
                /* Already logged inside the sender; never the caller's problem. */
            });

        return saved;
    }

    /**
     * Alerts for MY channel newer than `afterId` — what the screen turns into toasts.
     *
     * There is no read/unread here, on purpose. The client remembers the id of the
     * last alert it showed and passes it back, so the server keeps no per-user state:
     * nothing to mark, nothing to reset, and no second call to make.
     *
     * The marker is the ID and not the timestamp, which was tried first and repeated
     * itself. createdAt is stored as datetime(6) but serialises to milliseconds, so a
     * row written at .345678 comes back as .345; sent again as the marker it is still
     * "later than" itself and the same alert arrives on every poll. The id is exact
     * and monotonic, and cannot round.
     *
     * With no marker, the last few minutes — enough that a screen opening fresh shows
     * what just happened rather than a backlog nobody asked for. The window is short
     * deliberately: an alert is a nudge, and the list screens are where history lives.
     *
     * Rows are never deleted, so a report over them stays complete regardless.
     */
    async getAlertsAfter(ctx: RequestContext, afterId?: ID | null): Promise<TransferNotification[]> {
        const qb = this.connection
            .getRepository(ctx, TransferNotification)
            .createQueryBuilder('n')
            .where('n.recipientChannelId = :cid', { cid: ctx.channelId })
            .orderBy('n.id', 'ASC')
            .take(ALERT_MAX_ITEMS);

        if (afterId != null) {
            qb.andWhere('n.id > :afterId', { afterId });
        } else {
            qb.andWhere('n.createdAt > :cutoff', {
                cutoff: new Date(Date.now() - ALERT_DEFAULT_WINDOW_MINUTES * 60 * 1000),
            });
        }
        return qb.getMany();
    }
}
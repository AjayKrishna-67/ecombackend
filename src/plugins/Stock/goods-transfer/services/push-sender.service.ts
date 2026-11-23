import { Injectable } from '@nestjs/common';
import { Administrator, ID, Logger, TransactionalConnection } from '@vendure/core';
import webPush from 'web-push';

import { loggerCtx } from '../constants';
import { NotificationRefType } from '../types';

/**
 * Sends an alert to the branch's administrators as a browser notification.
 *
 * This is NOT a second notification system. TransferNotificationService writes the
 * row exactly as it always did, and the app shows it as a toast when it is open.
 * This adds the other case — the app closed, the person away from the screen — and
 * carries the same words to the same people.
 *
 * Nothing here can break a transfer. Push is attempted after the business work is
 * done and every failure is swallowed: a confirm must not roll back because a
 * browser somewhere has stopped listening.
 *
 * NOTHING HERE TOUCHES THE REQUEST'S TRANSACTION, and that is the whole point.
 *
 * The caller starts this with `void` — deliberately, so a stock movement is never
 * held up waiting on Google. But that means the work below outlives the transaction
 * it was started from: by the time a push service has answered, the confirm has
 * committed and Vendure has released the QueryRunner. Any query issued through
 * `getRepository(ctx, …)` after that point throws QueryRunnerAlreadyReleasedError.
 *
 * That is not theoretical. It is why a subscription that answered 410 Gone was never
 * actually forgotten: the clean-up ran on a released transaction, threw, and was
 * swallowed by the catch meant for database trouble. The dead address stayed on the
 * record and every later send failed against it, silently, forever.
 *
 * So every read and write here goes through `rawConnection` — the DataSource itself,
 * with no transaction attached. Nothing this service reads is written by the
 * transaction that triggered it (administrators and their subscriptions are not
 * touched by a transfer), so there is no uncommitted data to miss, and the timing
 * of the answer stops mattering.
 */

/** Set from .env at startup; without it, push is simply off. */
let configured = false;

function ensureConfigured(): boolean {
    if (configured) {
        return true;
    }
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    if (!publicKey || !privateKey) {
        return false;
    }
    // The subject identifies the sender to the push service; a mailto is the
    // convention and is only ever read by a human chasing an abusive sender.
    webPush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@kaaikani.co.in', publicKey, privateKey);
    configured = true;
    return true;
}

export interface PushPayload {
    title: string;
    body?: string;
    refType: NotificationRefType;
    refId: ID;
}

/** One browser's address, as the Push API describes it. */
interface StoredSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
}

/**
 * Every address stored against one administrator.
 *
 * A JSON ARRAY, one entry per browser. One person signs in on a laptop at the desk
 * and a phone in the warehouse, and while this field held a single address the one
 * that subscribed most recently silently took the notifications away from the other
 * — which looked exactly like push being broken on the first device.
 *
 * A lone object is still accepted, because that is what earlier versions wrote. A
 * value stored before this change keeps working and is folded into the array the
 * next time that browser subscribes; nothing needs migrating.
 */
function parseSubscriptions(raw: string | null | undefined): StoredSubscription[] {
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        const list = Array.isArray(parsed) ? parsed : [parsed];
        return list.filter(
            (entry): entry is StoredSubscription =>
                Boolean(entry) && typeof (entry as StoredSubscription).endpoint === 'string',
        );
    } catch {
        // A hand-edited or truncated value is treated as no subscriptions at all,
        // rather than throwing inside a send nobody is waiting on.
        return [];
    }
}

/**
 * Where tapping the notification should land.
 *
 * These are paths in the Goods Transfer section of the delivery dashboard, which is
 * where this module's screens live. The service worker turns them into absolute URLs
 * against its own scope, so nothing here needs to know the host.
 *
 * `damage` is the awkward one, and deliberately so. Its refId is the DAMAGE REQUEST
 * id, not the transfer's — see DamageService — and a damage request has no page of
 * its own: claims are read on the transfer they were raised against, because a claim
 * only means anything next to the lines and stock it concerns. There is therefore no
 * id here that can address the right page, so it opens the list rather than guessing
 * at a tab: an approval notice landing on "damage pending" would be actively
 * misleading. The title already names both the damage number and the transfer, and
 * the list's search box matches either — see the search filter in
 * TransferReportService, where the damage number was added for exactly this reason.
 * It was NOT matched when this comment was first written, so the sentence was a
 * promise the code did not keep: the number in the notification led nowhere.
 */
function notificationPath(refType: NotificationRefType, refId: ID): string {
    switch (refType) {
        case 'transfer':
            return `/goods-transfer/${refId}`;
        case 'expiry':
            return '/goods-transfer?status=EXPIRING_SOON';
        default:
            return '/goods-transfer';
    }
}

@Injectable()
export class PushSenderService {
    constructor(private connection: TransactionalConnection) {}

    /**
     * Every administrator who can act on this channel and has allowed notifications.
     *
     * Read through the channel join, so an admin is reached about a branch they
     * actually belong to and no other.
     */
    private async subscribersFor(channelId: ID): Promise<Administrator[]> {
        return this.connection.rawConnection
            .getRepository(Administrator)
            .createQueryBuilder('admin')
            .innerJoin('admin.user', 'user')
            .innerJoin('user.roles', 'role')
            .innerJoin('role.channels', 'channel', 'channel.id = :channelId', { channelId })
            .where('admin.deletedAt IS NULL')
            // Custom fields are an embedded entity, so the path goes through it —
            // the underlying column is customFieldsGtpushsubscription, but naming it
            // directly would tie this query to how TypeORM happens to flatten today.
            .andWhere('admin.customFields.gtPushSubscription IS NOT NULL')
            .andWhere("admin.customFields.gtPushSubscription != ''")
            .getMany();
    }

    /**
     * Fire and forget. Awaiting this inside a transaction would tie a stock movement
     * to whether Google's push service happens to answer, so callers do not.
     *
     * Takes no RequestContext on purpose — see the note at the top of this file. The
     * channel is passed as a plain id because that is the only thing about the
     * request that still means anything once the transaction is gone.
     */
    async send(channelId: ID, payload: PushPayload): Promise<void> {
        if (!ensureConfigured()) {
            Logger.verbose(
                'push: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push is off',
                loggerCtx,
            );
            return;
        }

        let admins: Administrator[];
        try {
            admins = await this.subscribersFor(channelId);
        } catch (err: any) {
            Logger.warn(`push: could not read subscribers for channel ${channelId}: ${err.message}`, loggerCtx);
            return;
        }
        if (!admins.length) {
            // Worth saying out loud. "Nobody on this branch has allowed notifications"
            // and "push is broken" look identical from the outside, and the first one
            // is by far the more common — usually the person being tested with has
            // simply not answered the browser's prompt yet.
            Logger.verbose(
                `push: nothing to send for channel ${channelId} — no administrator on it has a subscription`,
                loggerCtx,
            );
            return;
        }

        const message = JSON.stringify({
            title: payload.title,
            body: payload.body ?? '',
            // Same transfer, same tag — a later message replaces an earlier one
            // instead of stacking five notifications about one load.
            tag: `${payload.refType}-${payload.refId}`,
            url: notificationPath(payload.refType, payload.refId),
        });

        for (const admin of admins) {
            const subscriptions = parseSubscriptions(
                (admin.customFields as any)?.gtPushSubscription as string | undefined,
            );
            if (!subscriptions.length) {
                continue;
            }

            // Every browser this person has allowed — the laptop AND the phone.
            const dead: string[] = [];
            let delivered = 0;
            for (const subscription of subscriptions) {
                try {
                    await webPush.sendNotification(
                        subscription as unknown as webPush.PushSubscription,
                        message,
                        {
                            /*
                              Deliver NOW, not when the phone next happens to wake.

                              Without this the message goes out at the default
                              "normal" urgency, and Android's Doze batches normal
                              messages until the next maintenance window — which is
                              why a notification that the server sent instantly could
                              still take ten or more seconds to make a sound. "high"
                              sets the Urgency header the push service reads as
                              "wake the device for this one".

                              Justified here: every message this module sends is one
                              branch telling another that goods have moved, and a
                              person is waiting on it. It is not a digest.
                            */
                            urgency: 'high',
                            /*
                              Four hours. A phone switched off overnight should still
                              be told when it comes back, but "your transfer is on the
                              way" is not worth delivering the next morning — by then
                              the goods have arrived and the app shows the truth
                              anyway. The default is four weeks.
                            */
                            TTL: 4 * 60 * 60,
                        },
                    );
                    delivered++;
                } catch (err: any) {
                    // 404/410 mean this browser has thrown the subscription away —
                    // the person cleared their data or uninstalled. Forget THAT one
                    // rather than retrying forever against an address that no longer
                    // exists; the others are still good and must survive it.
                    if (err?.statusCode === 404 || err?.statusCode === 410) {
                        dead.push(subscription.endpoint);
                    } else {
                        // The status code is worth more than the message here. 403 is
                        // the one to recognise on sight: it means this server signed
                        // with a VAPID pair the browser did not subscribe with, which
                        // is a configuration mistake rather than a lapsed browser, and
                        // it fails every send until the keys are put back in step.
                        Logger.warn(
                            `push: send to admin ${admin.id} failed with ${err?.statusCode ?? '?'}: ${err?.message ?? err}`,
                            loggerCtx,
                        );
                    }
                }
            }

            // One line per recipient, so a test run can be read straight off the
            // console: who it went to, how many of their browsers took it, and how
            // many addresses turned out to be gone.
            Logger.verbose(
                `push: admin ${admin.id} — ${delivered}/${subscriptions.length} device(s) sent` +
                    (dead.length ? `, ${dead.length} gone` : ''),
                loggerCtx,
            );

            if (dead.length) {
                await this.forget(admin.id, subscriptions, dead);
            }
        }
    }

    /**
     * Drops only the addresses that answered "gone", keeping the rest.
     *
     * Re-reads the record rather than writing back the list this send started with.
     * Between that read and now, a browser somewhere may have subscribed — a phone
     * being switched on while a confirm is going out is an ordinary Tuesday — and
     * writing the stale list back would erase it. So the removal is expressed as a
     * removal: take what is on the record NOW, and take the dead addresses out of it.
     */
    private async forget(
        adminId: ID,
        _all: StoredSubscription[],
        deadEndpoints: string[],
    ): Promise<void> {
        const repository = this.connection.rawConnection.getRepository(Administrator);
        try {
            const current = await repository.findOne({ where: { id: adminId as any } });
            const kept = parseSubscriptions(
                (current?.customFields as any)?.gtPushSubscription as string | undefined,
            ).filter(s => !deadEndpoints.includes(s.endpoint));

            await repository.update(
                { id: adminId as any },
                {
                    customFields: {
                        gtPushSubscription: kept.length ? JSON.stringify(kept) : null,
                    },
                } as any,
            );
            Logger.verbose(
                `push: dropped ${deadEndpoints.length} dead subscription(s) for admin ${adminId}, ${kept.length} left`,
                loggerCtx,
            );
        } catch (err: any) {
            // Reported rather than swallowed. A clean-up that cannot run leaves a dead
            // address on the record, and every later send fails against it — the exact
            // failure this whole path exists to prevent, and one that is invisible
            // unless it is said.
            Logger.warn(
                `push: could not clear dead subscription(s) for admin ${adminId}: ${err?.message ?? err}`,
                loggerCtx,
            );
        }
    }
}

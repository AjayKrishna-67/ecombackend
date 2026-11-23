import { ID, Order, RequestContext, TransactionalConnection } from '@vendure/core';
import { LockNotSupportedOnGivenDriverError } from 'typeorm';

/**
 * Price lock: only a cart (AddingItems) may be repriced. Once the customer taps
 * Pay (ArrangingPayment) the Razorpay amount is fixed, so a reprice would make
 * the order total differ from what they pay (stuck order on a price rise,
 * silent overcharge on a drop).
 */
export const REPRICEABLE_STATE = 'AddingItems';

/**
 * Locks the order row (FOR UPDATE) inside the caller's transaction and returns
 * its latest committed state. Core `transitionToState` takes no row lock, so
 * without this a sync that read a cart can still write prices after the
 * customer tapped Pay. A locking read sees the latest commit even under MySQL
 * REPEATABLE READ; SQLite (e2e tests) has no row locks and serializes writes
 * itself, so it falls back to a plain read.
 */
export async function lockOrderAndReadState(
    connection: TransactionalConnection,
    ctx: RequestContext,
    orderId: ID,
): Promise<string | undefined> {
    const query = connection.getRepository(ctx, Order).createQueryBuilder('o').where('o.id = :id', { id: orderId });
    try {
        return (await query.clone().setLock('pessimistic_write').getOne())?.state;
    } catch (e) {
        if (!(e instanceof LockNotSupportedOnGivenDriverError)) {
            throw e;
        }
        return (await query.getOne())?.state;
    }
}

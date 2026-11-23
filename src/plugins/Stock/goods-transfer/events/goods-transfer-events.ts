import { RequestContext, VendureEvent } from '@vendure/core';

import { GoodsTransfer } from '../entities/goods-transfer.entity';
import { DamageRequest } from '../entities/damage-request.entity';

/**
 * Domain events (TDS §22). Published with ctx → Vendure's transaction-aware
 * EventBus delivers them ONLY AFTER COMMIT, so out-of-app notifications can
 * never fire for a rolled-back action. In-app bell rows are written inside the
 * transaction by TransferNotificationService instead.
 */

export class GoodsTransferConfirmedEvent extends VendureEvent {
    constructor(public ctx: RequestContext, public transfer: GoodsTransfer) {
        super();
    }
}

export class GoodsTransferDispatchedEvent extends VendureEvent {
    constructor(public ctx: RequestContext, public transfer: GoodsTransfer) {
        super();
    }
}

/** Destination accepted the goods — the one event that means stock was written. */
export class GoodsTransferReceivedEvent extends VendureEvent {
    constructor(public ctx: RequestContext, public transfer: GoodsTransfer) {
        super();
    }
}

export class DamageRequestConfirmedEvent extends VendureEvent {
    constructor(public ctx: RequestContext, public damageRequest: DamageRequest, public transfer: GoodsTransfer) {
        super();
    }
}

export class DamageRequestApprovedEvent extends VendureEvent {
    constructor(public ctx: RequestContext, public damageRequest: DamageRequest, public transfer: GoodsTransfer) {
        super();
    }
}

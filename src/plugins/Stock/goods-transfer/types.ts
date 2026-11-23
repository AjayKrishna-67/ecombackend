/**
 * Enums & shared types for the GoodsTransferPlugin (SPEC §2).
 *
 *   GoodsTransfer: (REQUEST_DRAFT -> REQUESTED ->) DRAFT -> CONFIRMED -> DISPATCHED -> RECEIVED
 *   DamageRequest: DRAFT -> PENDING_APPROVAL -> APPROVED | REJECTED
 *
 * The transfer flow is strictly forward. There is no reversal: correcting a load is
 * an EDIT in place (allowed at DRAFT, CONFIRMED and DISPATCHED), so the transfer
 * never goes backwards and its number is never reissued. RECEIVED is terminal —
 * destination stock is written, and changing that is a damage claim, not an edit.
 */

export enum TransferState {
    /**
     * A request the receiving branch is still writing. Nobody else can see it.
     *
     * Exists because a request is checked on paper before it is sent: the branch ticks
     * fifty products, prints the sheet, walks the shelves and comes back to correct it.
     * Without somewhere to keep that, the choice was to send an unchecked request or to
     * hold the screen open until the walk was done.
     *
     * Invisible to the source until it is sent, which is the whole point — a draft that
     * showed up in the other branch's list would be a request, not a draft.
     */
    RequestDraft = 'REQUEST_DRAFT',
    /**
     * Raised by the RECEIVING branch, asking the source to send these items.
     *
     * The only state whose creator is the destination rather than the source, which is
     * why `requestedAt` exists on the entity: the moment the source accepts it the row
     * becomes an ordinary DRAFT and nothing downstream can tell the two apart. That
     * timestamp is what keeps the requesting branch's own list honest.
     */
    Requested = 'REQUESTED',
    Draft = 'DRAFT',
    /** Lines locked, Transfer PDF generated, destination notified (BR-06). */
    Confirmed = 'CONFIRMED',
    /** Goods physically left the source branch (BR-07). */
    Dispatched = 'DISPATCHED',
    /** Destination accepted the goods — stock added (GT-02). Terminal. */
    Received = 'RECEIVED',
}

export enum DamageState {
    /** Kept for existing rows only — new requests are created already sent. */
    Draft = 'DRAFT',
    /** Raised + sent by the destination in one step — awaiting a decision. */
    PendingApproval = 'PENDING_APPROVAL',
    /** Approved by SuperAdmin — stock deducted, Damage PDF generated (BR-13/16). Terminal. */
    Approved = 'APPROVED',
    /** Rejected by SuperAdmin — NO stock change. Terminal (Phase 2). */
    Rejected = 'REJECTED',
}

export enum TransferNotificationType {
    /** The destination asked this branch to send items — nothing is moving yet. */
    TransferRequested = 'TRANSFER_REQUESTED',
    TransferConfirmed = 'TRANSFER_CONFIRMED',
    /** Source changed the lines after the destination was already told about it. */
    TransferUpdated = 'TRANSFER_UPDATED',
    TransferDispatched = 'TRANSFER_DISPATCHED',
    /**
     * The source deleted a transfer the destination had already been told about.
     * Without this the destination waits for goods that are no longer coming.
     */
    TransferDeleted = 'TRANSFER_DELETED',
    TransferReceived = 'TRANSFER_RECEIVED',
    DamageConfirmed = 'DAMAGE_CONFIRMED',
    DamageApproved = 'DAMAGE_APPROVED',
    DamageRejected = 'DAMAGE_REJECTED',
    /** Stocked goods nearing shelf life — destination branch only, raised once per line. */
    ExpirySoon = 'EXPIRY_SOON',
}

/**
 * Kinds used by the atomic document-number sequence (PLAN.md §2.4).
 *
 * Exactly two numbers are issued: one naming a transfer, one naming a damage claim.
 * Both are assigned at creation, so a record is nameable from the moment it exists.
 *
 * There is no kind for a document. A PDF is titled by the number of the thing it
 * documents — a separate sequence for the paper said nothing its subject's number
 * did not, and left a number consumed on every reprint.
 */
export enum DocumentKind {
    TransferNumber = 'transfer',
    DamageNumber = 'damage',
}

/** Deep-link target types for notifications (TDS §17). */
export type NotificationRefType = 'transfer' | 'damage' | 'expiry';

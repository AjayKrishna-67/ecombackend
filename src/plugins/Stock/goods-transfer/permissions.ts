import { CrudPermissionDefinition, PermissionDefinition } from '@vendure/core';

/**
 * Custom permissions for the GoodsTransferPlugin (TDS §13).
 *
 * Role mapping (BRS §2):
 *  - Transfer Manager  : goodsTransferPermission.Create/Read/Update/Delete + viewTransferReportsPermission
 *  - Receiving Manager : goodsTransferPermission.Read + approveGoodsTransferReceiptPermission
 *                        + recordTransferDamagePermission
 *  - Damage Approver   : approveTransferDamagePermission
 *  - SuperAdmin        : everything.
 *
 * Damage approval/rejection is granted through approveTransferDamagePermission so it
 * can be assigned to a role like every other action here. It is kept as its own
 * definition (not folded into recordTransferDamagePermission) because raising a damage
 * request and approving one — which deducts destination stock — must stay separable.
 */

/** Create / Read / Update / Delete on goods transfers (drafting, confirming, dispatching). */
export const goodsTransferPermission = new CrudPermissionDefinition('GoodsTransfer');

/** Approve receipt of an incoming transfer at the destination branch (BR-08/09). */
export const approveGoodsTransferReceiptPermission = new PermissionDefinition({
    name: 'ApproveGoodsTransferReceipt',
    description: 'Allows approving receipt of an incoming goods transfer (updates destination stock)',
});

/** Record & confirm damage requests at the destination branch (BR-10/11). */
export const recordTransferDamagePermission = new PermissionDefinition({
    name: 'RecordTransferDamage',
    description: 'Allows recording and confirming damage requests for approved goods transfers',
});

/** Approve or reject a pending damage request — deducts destination stock (BR-13/16). */
export const approveTransferDamagePermission = new PermissionDefinition({
    name: 'ApproveTransferDamage',
    description: 'Allows approving or rejecting damage requests (approval deducts destination stock)',
});

/** View the goods-transfer report suite (BRS §9). */
export const viewTransferReportsPermission = new PermissionDefinition({
    name: 'ViewTransferReports',
    description: 'Allows viewing goods transfer, damage and stock movement reports',
});

/** All definitions to register in configuration() — keep in one place. */
export const allGoodsTransferPermissions = [
    goodsTransferPermission,
    approveGoodsTransferReceiptPermission,
    recordTransferDamagePermission,
    approveTransferDamagePermission,
    viewTransferReportsPermission,
];

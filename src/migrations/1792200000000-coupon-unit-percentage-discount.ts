import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Discount specified products by %" (products_percentage_discount) now
 * discounts only the coupon's own unit, and the interim separate action for
 * that, `coupon_product_percentage_discount`, is gone. A promotion saved with
 * the interim code would throw when its coupon is applied (Vendure looks the
 * action up by code without a check), so it is renamed to the code that now
 * does the same thing. Its arguments (discount, productVariantIds) are the
 * same.
 *
 * Promotions saved with Vendure core's products_percentage_discount need no
 * change: the code and argument names are kept, only the behaviour moved to
 * the coupon unit.
 *
 * Plain SQL that both MySQL and the e2e suite's SQLite run. Promotion.actions
 * is TypeORM simple-json (JSON.stringify, no spaces), so the code appears as
 * the exact text `"code":"coupon_product_percentage_discount"`.
 */
export class CouponUnitPercentageDiscount1792200000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query(
            `UPDATE promotion
                SET actions = REPLACE(actions, '"code":"coupon_product_percentage_discount"', '"code":"products_percentage_discount"')
              WHERE actions LIKE '%"code":"coupon_product_percentage_discount"%'`,
        );
    }

    public async down(): Promise<any> {
        // Nothing to undo: which promotions used the interim code is not
        // recorded, and the code this build registers serves them all.
    }
}

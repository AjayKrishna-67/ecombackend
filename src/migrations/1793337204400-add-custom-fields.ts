import {MigrationInterface, QueryRunner} from "typeorm";

export class AddCustomFields1793337204400 implements MigrationInterface {

   public async up(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query("ALTER TABLE `product_variant` DROP COLUMN `customFieldsStockunit`", undefined);
        await queryRunner.query("ALTER TABLE `product_variant` DROP COLUMN `customFieldsWeight`", undefined);
        await queryRunner.query("ALTER TABLE `order` ADD `customFieldsPlacedviawhatsapp` tinyint NULL DEFAULT 0", undefined);
        await queryRunner.query("ALTER TABLE `session` ADD `customFieldsUseragent` varchar(512) NULL", undefined);
        await queryRunner.query("ALTER TABLE `session` ADD `customFieldsIpaddress` varchar(255) NULL", undefined);
        await queryRunner.query("ALTER TABLE `session` ADD `customFieldsLastseenat` datetime(6) NULL", undefined);
        await queryRunner.query("ALTER TABLE `goods_transfer_line` ADD `poolUnit` varchar(16) NULL", undefined);
        await queryRunner.query("ALTER TABLE `goods_transfer` ADD `requestedAt` datetime NULL", undefined);
        await queryRunner.query("ALTER TABLE `goods_transfer` ADD `requestedByName` varchar(255) NULL", undefined);
        await queryRunner.query("ALTER TABLE `damage_request_line` ADD `poolUnit` varchar(16) NULL", undefined);
   }

   public async down(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query("ALTER TABLE `damage_request_line` DROP COLUMN `poolUnit`", undefined);
        await queryRunner.query("ALTER TABLE `goods_transfer` DROP COLUMN `requestedByName`", undefined);
        await queryRunner.query("ALTER TABLE `goods_transfer` DROP COLUMN `requestedAt`", undefined);
        await queryRunner.query("ALTER TABLE `goods_transfer_line` DROP COLUMN `poolUnit`", undefined);
        await queryRunner.query("ALTER TABLE `session` DROP COLUMN `customFieldsLastseenat`", undefined);
        await queryRunner.query("ALTER TABLE `session` DROP COLUMN `customFieldsIpaddress`", undefined);
        await queryRunner.query("ALTER TABLE `session` DROP COLUMN `customFieldsUseragent`", undefined);
        await queryRunner.query("ALTER TABLE `order` DROP COLUMN `customFieldsPlacedviawhatsapp`", undefined);
        await queryRunner.query("ALTER TABLE `product_variant` ADD `customFieldsWeight` int NULL", undefined);
        await queryRunner.query("ALTER TABLE `product_variant` ADD `customFieldsStockunit` varchar(255) CHARACTER SET \"latin1\" COLLATE \"latin1_swedish_ci\" NULL DEFAULT 'piece'", undefined);
   }

}

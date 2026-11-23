import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * A free-form, internal product/variant tag (Shopify-style).
 *
 * Named CatalogTag (not Tag) because Vendure core already ships a `Tag` entity
 * + GraphQL type (used for Asset tagging). This is a distinct catalog label
 * system for Products/Variants.
 *
 * GLOBAL scope: a CatalogTag is identified by its `key` alone and is visible /
 * usable from every channel. (It used to be per-channel, unique on
 * (key, channelId); made global in migration GlobalTags1784100000000 so the
 * cross-channel Price Matrix can find a tag regardless of which channel its
 * products live in.)
 *
 * `key` = normalized (lowercased, trimmed); the unique-index + autocomplete
 * target. `value` = human display form.
 */
@Entity()
@Index(['key'], { unique: true })
export class CatalogTag extends VendureEntity {
    constructor(input?: DeepPartial<CatalogTag>) {
        super(input);
    }

    @Column()
    value: string;

    @Column()
    key: string;
}

import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

/**
 * One login link sent over WhatsApp. The raw secret exists only inside the link;
 * this row keeps its SHA-256 so a leaked database dump cannot be replayed. The row
 * is deleted the moment the link is used (single use) or purged once expired.
 */
@Entity()
export class WhatsappLoginToken extends VendureEntity {
    constructor(input?: DeepPartial<WhatsappLoginToken>) {
        super(input);
    }

    @Index({ unique: true })
    @Column({ length: 64 })
    secretHash: string;

    /** Bare 10-digit mobile, the format customer.phoneNumber uses. */
    @Column({ length: 25 })
    phoneNumber: string;

    /** WhatsApp profile name, cleaned. Only used if a new account is created. */
    @Column({ length: 255, default: '' })
    firstName: string;

    @Index()
    @Column({ type: 'datetime' })
    expiresAt: Date;
}

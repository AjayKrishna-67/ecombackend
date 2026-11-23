import {
    DeepPartial,
    VendureEntity
  } from '@vendure/core';
  import { Column, Entity, Index } from 'typeorm';


  @Entity()
  export class AuthenticationPhoneOtp extends VendureEntity {

    constructor(input?: DeepPartial<AuthenticationPhoneOtp>) {
      super(input);
    }

    @Column({ length: 25 })
    @Index()
    phoneNumber: string;

    @Column({ length: 25 })
    code: string;

    // Past expiry, the row is treated as invalid by verifyOtp and is purged
    // by the scheduled cleanup. Nullable for safe rollout against existing rows.
    @Column({ type: 'datetime', nullable: true })
    expiresAt: Date | null;

  }
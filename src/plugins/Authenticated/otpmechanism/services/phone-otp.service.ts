//

import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { totp } from 'otplib';
import { MoreThan } from 'typeorm';
import { TransactionalConnection, RequestContext } from '@vendure/core';
import { AuthenticationPhoneOtp } from '../entities/authentication-phone-otp.entity';
import { SmsService } from '../../../../smsService';

const OTP_TTL_MS = 5 * 60_000;
const VERIFY_RATE_WINDOW_MS = 60_000;
const VERIFY_RATE_MAX_ATTEMPTS = 10;

type AttemptWindow = { windowStart: number; count: number };

@Injectable()
export class PhoneOtpService implements OnApplicationBootstrap {

  // In-memory per-phone counters. Process-local — fine for a single node;
  // for multi-node deployments back this with Redis.
  private readonly verifyAttempts = new Map<string, AttemptWindow>();

  constructor(
    private connection: TransactionalConnection,
    private smsService: SmsService,
  ) {}

  onApplicationBootstrap() {}

  /** Returns true if the caller is within the limit; false if blocked. */
  private consumeVerifyAttempt(phoneNumber: string): boolean {
    const now = Date.now();
    const existing = this.verifyAttempts.get(phoneNumber);
    if (!existing || now - existing.windowStart > VERIFY_RATE_WINDOW_MS) {
      this.verifyAttempts.set(phoneNumber, { windowStart: now, count: 1 });
      return true;
    }
    existing.count += 1;
    return existing.count <= VERIFY_RATE_MAX_ATTEMPTS;
  }

  async sendOtp(ctx: RequestContext, phoneNumber: string): Promise<string | null> {
    totp.options = { digits: 4 };
    const token = totp.generate(`${process.env.TOTP_SALT}:${phoneNumber}`);

    console.log('Generated OTP:', token);  // Debugging OTP generation

    try {
      const repository = this.connection.getRepository(ctx, AuthenticationPhoneOtp);

      let phoneOtp = await repository.findOne({ where: { phoneNumber } });

      if (!phoneOtp) {
        phoneOtp = new AuthenticationPhoneOtp();
        phoneOtp.phoneNumber = phoneNumber;
      }

      phoneOtp.code = token;
      phoneOtp.expiresAt = new Date(Date.now() + OTP_TTL_MS);

      console.log('Saving OTP to DB:', phoneOtp);
      await repository.save(phoneOtp);
  
      const sms = new SmsService(
        "6837fbafd6fc05485c278e03", // Template ID
        phoneNumber,
        { var: token, Var:"cRQByF/CLA6"}
      );
  
      const smsResult = await sms.sendSms();
      console.log('SMS Sent:', smsResult);
  
      return token;
    } catch (error) {
      console.error('Error in sendOtp:', error);
      return null;
    }
  }
  
  async resendOtp(ctx: RequestContext, phoneNumber: string): Promise<string | null> {
    totp.options = { digits: 4 };
    const token = totp.generate(`${process.env.TOTP_SALT}:${phoneNumber}`);

    console.log('Generated Resend OTP:', token);

    try {
      const repository = this.connection.getRepository(ctx, AuthenticationPhoneOtp);

      let phoneOtp = await repository.findOne({ where: { phoneNumber } });

      if (!phoneOtp) {
        phoneOtp = new AuthenticationPhoneOtp();
        phoneOtp.phoneNumber = phoneNumber;
      }

      phoneOtp.code = token;
      phoneOtp.expiresAt = new Date(Date.now() + OTP_TTL_MS);

      console.log('Saving Resend OTP to DB:', phoneOtp);
      await repository.save(phoneOtp);
  
      const sms = new SmsService(
        "6837fbafd6fc05485c278e03", // Different template ID for resend
        phoneNumber,
        { var: token }
      );
  
      const smsResult = await sms.sendSms();
      console.log('Resend SMS Sent:', smsResult);
  
      return token;
    } catch (error) {
      console.error('Error in resendOtp:', error);
      return null;
    }
  }
  
  
  

  async verifyOtp(ctx: RequestContext, phoneNumber: string, code: string): Promise<boolean> {
    if (!this.consumeVerifyAttempt(phoneNumber)) {
      console.warn('[PhoneOtpService] [verifyOtp] RATE LIMITED for phone:', phoneNumber);
      return false;
    }
    // Atomic compare-and-delete. Only one concurrent caller wins (affected = 1);
    // the others see affected = 0 and return false. Also enforces TTL via expiresAt.
    try {
      const repository = this.connection.getRepository(ctx, AuthenticationPhoneOtp);
      const result = await repository.delete({
        phoneNumber,
        code,
        expiresAt: MoreThan(new Date()),
      });
      const verified = (result.affected ?? 0) > 0;
      console.log('[PhoneOtpService] [verifyOtp] Phone:', phoneNumber, '| verified:', verified);
      return verified;
    } catch (error) {
      console.error('[PhoneOtpService] [verifyOtp] ERROR:', error instanceof Error ? error.message : error);
      return false;
    }
  }
}

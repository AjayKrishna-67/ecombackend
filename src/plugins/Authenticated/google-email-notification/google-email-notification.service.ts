// src/plugins/google-email-notification/google-email-notification.service.ts
import { Injectable } from '@nestjs/common';
import { AccountRegistrationEvent, Logger } from '@vendure/core';

const loggerCtx = 'GoogleEmailNotificationService';

@Injectable()
export class GoogleEmailNotificationService {
  async handleGoogleRegistration(event: AccountRegistrationEvent) {
    const user = event.user;
    
    // Check if the user was authenticated via Google
    const isGoogleAuth = user.authenticationMethods?.some(
      (method: any) => method.strategy === 'google'
    );

    if (isGoogleAuth) {
      Logger.info(
        `New Google user registered: ${user.identifier}`,
        loggerCtx
      );
      // The actual email will be sent by the EmailPlugin using our custom handler
      // This is just for logging purposes
    }
  }
}


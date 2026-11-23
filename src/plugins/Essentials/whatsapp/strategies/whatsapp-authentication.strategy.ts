import { AuthenticationStrategy, Injector, RequestContext, User } from '@vendure/core';
import { DocumentNode } from 'graphql';
import gql from 'graphql-tag';

import { PhoneCustomerService } from '../../../Authenticated/shared/phone-customer.service';
import { STRATEGY_WHATSAPP } from '../constants';
import { WhatsappLoginService } from '../services/whatsapp-login.service';

export interface WhatsappAuthData {
    token: string;
}

export const EXPIRED_LINK_MESSAGE =
    'This WhatsApp login link has expired or was already used. Send us a message on WhatsApp to get a new one.';

/**
 * Logs a customer in from the link our WhatsApp bot sent them. Meta's signed
 * webhook already proved they own the phone number, so there is no OTP step —
 * the single-use link secret is the credential. Account lookup/creation is
 * shared with the SMS OTP login, so one phone is always one account.
 */
export class WhatsappAuthenticationStrategy implements AuthenticationStrategy<WhatsappAuthData> {
    readonly name = STRATEGY_WHATSAPP;
    private loginService: WhatsappLoginService;
    private phoneCustomerService: PhoneCustomerService;

    init(injector: Injector): void {
        this.loginService = injector.get(WhatsappLoginService);
        this.phoneCustomerService = injector.get(PhoneCustomerService);
    }

    defineInputType(): DocumentNode {
        return gql`
            input WhatsappAuthInput {
                token: String!
            }
        `;
    }

    async authenticate(ctx: RequestContext, data: WhatsappAuthData): Promise<User | string> {
        const login = await this.loginService.consume(ctx, data.token);
        if (!login) {
            return EXPIRED_LINK_MESSAGE;
        }
        return this.phoneCustomerService.findOrCreateUser(ctx, {
            phoneNumber: login.phoneNumber,
            firstName: login.firstName,
            lastName: '',
        });
    }
}

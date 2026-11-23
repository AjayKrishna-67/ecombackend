import { Customer, ExternalAuthenticationMethod, mergeConfig, NativeAuthenticationStrategy, TransactionalConnection, User } from '@vendure/core';
import { createTestEnvironment, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import gql from 'graphql-tag';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SmsService } from '../../../../smsService';
import { AccountDeletionRequestPlugin } from '../../../Essentials/account-deletion-request/account-deletion-request.plugin';
import { initialData } from '../../../Essentials/scheduled-availability/e2e/fixtures/initial-data';
import { PhoneOtpPlugin } from '../../otpmechanism/plugins/phone-otp.plugin';
import { PhoneOtpService } from '../../otpmechanism/services/phone-otp.service';
import { PhoneOtpAuthenticationStrategy } from '../../otpmechanism/strategies/phone-otp.strategy';
import { PhoneNumberUniqueValidatorPlugin } from '../../phone-number-unique-validator/phone-number-unique-validator.plugin';
import { GoogleAuthenticationStrategy } from '../google-authentication-strategy';

/*
 * Google login against accounts that already exist, and admin deletion of an
 * account whose login was deleted on its own (live customer 25077 / user 24964:
 * every Google login made a new account and the admin could not delete it).
 * Only Google's token check, the OTP check and SMS are stubbed.
 */

const dataDir = path.join(process.cwd(), 'src/plugins/Authenticated/google-auth/e2e/__data__');
registerInitializer('sqljs', new SqljsInitializer(dataDir));

vi.spyOn(GoogleAuthenticationStrategy.prototype as any, 'verifyGoogleToken').mockImplementation(async (token: any) =>
    JSON.parse(token),
);
vi.spyOn(PhoneOtpService.prototype, 'verifyOtp').mockImplementation(async (_ctx: any, _phone: string, code: string) => code === '1234');
vi.spyOn(PhoneOtpService.prototype, 'sendOtp').mockRejectedValue(new Error('no OTP in tests'));
vi.spyOn(SmsService.prototype, 'sendSms').mockRejectedValue(new Error('no SMS in tests'));

const config = mergeConfig(testConfig, {
    apiOptions: { port: 3063 },
    plugins: [PhoneOtpPlugin, PhoneNumberUniqueValidatorPlugin, AccountDeletionRequestPlugin],
});
config.authOptions.shopAuthenticationStrategy = [
    new PhoneOtpAuthenticationStrategy(),
    new NativeAuthenticationStrategy(),
    new GoogleAuthenticationStrategy('test-client-id'),
];
const { server, adminClient, shopClient } = createTestEnvironment(config);

const AUTHENTICATE = gql`
    mutation Authenticate($input: AuthenticationInput!) {
        authenticate(input: $input) {
            ... on CurrentUser {
                id
                identifier
            }
            ... on ErrorResult {
                errorCode
                message
            }
        }
    }
`;
const ACTIVE_CUSTOMER = gql`
    query {
        activeCustomer {
            id
        }
    }
`;
const DELETE_CUSTOMER = gql`
    mutation DeleteCustomer($id: ID!) {
        deleteCustomer(id: $id) {
            result
        }
    }
`;
const DELETE_CUSTOMERS = gql`
    mutation DeleteCustomers($ids: [ID!]!) {
        deleteCustomers(ids: $ids) {
            result
        }
    }
`;

const rawId = (id: string) => Number(String(id).replace('T_', ''));
const testId = (id: number) => `T_${id}`;

describe('Google login and existing accounts (e2e)', () => {
    let connection: TransactionalConnection;

    beforeAll(async () => {
        await server.init({ initialData, customerCount: 0 });
        await adminClient.asSuperAdmin();
        connection = server.app.get(TransactionalConnection);
    }, 180_000);

    afterAll(async () => {
        await server.destroy();
    });

    /** Phone-OTP sign-up as the apps do it; returns the new customer's id. */
    const phoneSignUp = async (phoneNumber: string, emailAddress?: string): Promise<number> => {
        await shopClient.asAnonymousUser();
        await shopClient.query(AUTHENTICATE, {
            input: { phoneOtp: { phoneNumber, code: '1234', firstName: 'Phone', lastName: 'User', emailAddress } },
        });
        const { activeCustomer } = await shopClient.query(ACTIVE_CUSTOMER);
        return rawId(activeCustomer.id);
    };

    /** Google sign-in; returns the customer it lands on. */
    const googleLogin = async (sub: string, email: string): Promise<number> => {
        await shopClient.asAnonymousUser();
        await shopClient.query(AUTHENTICATE, {
            input: { google: { token: JSON.stringify({ sub, email, given_name: 'Google' }) } },
        });
        const { activeCustomer } = await shopClient.query(ACTIVE_CUSTOMER);
        return rawId(activeCustomer.id);
    };

    const customer = (id: number) =>
        connection.rawConnection.getRepository(Customer).findOneOrFail({ where: { id }, relations: ['user'] });

    /** The state live user 24964 was in: the customer active, its login deleted. */
    const deleteLoginOnly = async (customerId: number) => {
        const { user } = await customer(customerId);
        await connection.rawConnection.getRepository(User).update({ id: user!.id }, { deletedAt: new Date() });
    };

    const activeCustomersWithEmail = (emailAddress: string) =>
        connection.rawConnection
            .getRepository(Customer)
            .createQueryBuilder('customer')
            .where('customer.emailAddress = :emailAddress AND customer.deletedAt IS NULL', { emailAddress })
            .getCount();

    it('keeps the Google link it makes to a phone account with the same email', async () => {
        const email = 'linked.user@gmail.com';
        const phoneCustomerId = await phoneSignUp('9100000001', email);

        expect(await googleLogin('sub-linked', email)).toBe(phoneCustomerId);

        const { user } = await customer(phoneCustomerId);
        const googleRows = await connection.rawConnection
            .getRepository(ExternalAuthenticationMethod)
            .find({ where: { strategy: 'google', externalIdentifier: 'sub-linked' }, relations: ['user'] });
        expect(googleRows.map(r => r.user?.id ?? null)).toEqual([user!.id]);
        // The phone login stays attached too.
        const methods = await connection.rawConnection
            .getRepository(User)
            .findOneOrFail({ where: { id: user!.id }, relations: ['authenticationMethods'] });
        expect(methods.authenticationMethods.map(m => (m as ExternalAuthenticationMethod).strategy).sort()).toEqual([
            'google',
            'phoneOtp',
        ]);
    });

    it('lets the admin delete a customer whose login was already deleted', async () => {
        const email = 'stuck.user@gmail.com';
        const stuckId = await phoneSignUp('9100000002', email);
        await deleteLoginOnly(stuckId);

        const { deleteCustomer } = await adminClient.query(DELETE_CUSTOMER, { id: testId(stuckId) });

        expect(deleteCustomer.result).toBe('DELETED');
        const after = await customer(stuckId);
        expect(after.deletedAt).not.toBeNull();
        expect(after.user!.deletedAt).not.toBeNull();
    });

    it('deletes a stuck and a healthy customer together', async () => {
        const stuckId = await phoneSignUp('9100000003', 'stuck.two@gmail.com');
        const healthyId = await phoneSignUp('9100000004', 'healthy.two@gmail.com');
        await deleteLoginOnly(stuckId);

        const { deleteCustomers } = await adminClient.query(DELETE_CUSTOMERS, {
            ids: [testId(stuckId), testId(healthyId)],
        });

        expect(deleteCustomers.map((r: { result: string }) => r.result)).toEqual(['DELETED', 'DELETED']);
        for (const id of [stuckId, healthyId]) {
            const after = await customer(id);
            expect(after.deletedAt).not.toBeNull();
            expect(after.user!.deletedAt).not.toBeNull();
        }
    });

    it('makes one new account, not one per login, once the stuck customer is deleted', async () => {
        const email = 'stuck.three@gmail.com';
        const stuckId = await phoneSignUp('9100000005', email);
        await deleteLoginOnly(stuckId);
        await adminClient.query(DELETE_CUSTOMER, { id: testId(stuckId) });

        const first = await googleLogin('sub-three', email);
        const second = await googleLogin('sub-three', email);

        expect(second).toBe(first);
        expect(await activeCustomersWithEmail(email)).toBe(1);
    });
});

import { LanguageCode, PluginCommonModule, VendurePlugin } from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import path from 'path';
import { DeleteCustomerResolver } from './delete-customer.resolver';
import { AdminDeleteCustomerResolver } from './api/admin-delete-customer.resolver';
import { CustomerDeletionResolver } from './api/customer-deletion.resolver';
import gql from 'graphql-tag';

const shopSchemaExtension = gql`
    type AccountDeletionResponse {
        success: Boolean!
        message: String!
    }

    type AccountDeletionStatus {
        isDeletionRequested: Boolean!
        reason: String
    }

    extend type Mutation {
        requestAccountDeletion(reason: String): AccountDeletionResponse!
        cancelAccountDeletion: AccountDeletionResponse!
    }

    extend type Query {
        accountDeletionStatus: AccountDeletionStatus
    }
`;

const adminSchemaExtension = gql`
    type CustomerDeletionRequest {
        id: ID!
        firstName: String!
        lastName: String!
        phoneNumber: String!
        emailAddress: String!
        reason: String!
        requestedDate: String!
    }

    type CustomerDeletionRequestList {
        items: [CustomerDeletionRequest!]!
        totalItems: Int!
    }

    extend type Query {
        customersWithDeletionRequest(skip: Int, take: Int): CustomerDeletionRequestList!
    }
`;

@VendurePlugin({
    imports: [PluginCommonModule],
    compatibility: '^3.6.3',
    configuration: (config) => {
        config.customFields.Customer.push(
            {
                name: 'isDeletionRequested',
                type: 'boolean',
                defaultValue: false,
                public: true,
                label: [{ languageCode: LanguageCode.en, value: 'Deletion Requested' }],
                description: [{ languageCode: LanguageCode.en, value: 'Whether the customer has requested account deletion' }],
            },
            {
                name: 'deletionRequestReason',
                type: 'string',
                nullable: true,
                public: true,
                label: [{ languageCode: LanguageCode.en, value: 'Deletion Request Reason' }],
                description: [{ languageCode: LanguageCode.en, value: 'Reason provided by the customer for account deletion' }],
            },
            {
                name: 'deletionRequestedAt',
                type: 'datetime',
                nullable: true,
                internal: true,
                label: [{ languageCode: LanguageCode.en, value: 'Deletion Requested At' }],
                description: [{ languageCode: LanguageCode.en, value: 'Date when account deletion was requested' }],
            },
        );
        return config;
    },
    shopApiExtensions: {
        schema: shopSchemaExtension,
        resolvers: [DeleteCustomerResolver],
    },
    adminApiExtensions: {
        schema: adminSchemaExtension,
        // AdminDeleteCustomerResolver overrides the built-in deleteCustomer(s) (no schema change).
        resolvers: [CustomerDeletionResolver, AdminDeleteCustomerResolver],
    },
    providers: [],
    dashboard: './dashboard/index.tsx',
})
export class AccountDeletionRequestPlugin {
    static ui: AdminUiExtension = {
        extensionPath: path.join(__dirname, 'ui'),
        providers: ['providers.ts'],
    };
}

import { Query, Resolver } from '@nestjs/graphql';
import { Allow, Permission } from '@vendure/core';
import gql from 'graphql-tag';

export const takeAwayAdminApiExtensions = gql`
    extend type Query {
        """
        Google Maps JS API key for the store-location picker. Empty string when
        GOOGLE_MAPS_API_KEY is not configured (the picker falls back to
        paste-a-maps-link mode).
        """
        googleMapsApiKey: String!
    }
`;

@Resolver()
export class TakeAwayAdminResolver {
    @Query()
    @Allow(Permission.Authenticated)
    googleMapsApiKey(): string {
        return process.env.GOOGLE_MAPS_API_KEY ?? '';
    }
}

import { graphql } from '@vendure/dashboard';

export const getPostalCodesDocument = graphql(`
    query GetPostalCodes($options: PostalCodeListOptions) {
        postalCodes(options: $options) {
            items {
                id
                code
                isAnywhere
                areas {
                    id
                    name
                }
            }
            totalItems
        }
    }
`);

export const getPostalCodeDocument = graphql(`
    query GetPostalCode($id: ID!) {
        postalCode(id: $id) {
            id
            code
            isAnywhere
            areas {
                id
                name
                enabled
            }
        }
    }
`);

export const createPostalCodeDocument = graphql(`
    mutation CreatePostalCode($input: CreatePostalCodeInput!) {
        createPostalCode(input: $input) {
            id
            code
            isAnywhere
        }
    }
`);

export const updatePostalCodeDocument = graphql(`
    mutation UpdatePostalCode($input: UpdatePostalCodeInput!) {
        updatePostalCode(input: $input) {
            id
            code
        }
    }
`);

export const deletePostalCodeDocument = graphql(`
    mutation DeletePostalCode($id: ID!) {
        deletePostalCode(id: $id) {
            result
            message
        }
    }
`);

export const createAreaDocument = graphql(`
    mutation CreatePostalCodeArea($input: CreatePostalCodeAreaInput!) {
        createPostalCodeArea(input: $input) {
            id
            name
            enabled
        }
    }
`);

export const updateAreaDocument = graphql(`
    mutation UpdatePostalCodeArea($input: UpdatePostalCodeAreaInput!) {
        updatePostalCodeArea(input: $input) {
            id
            name
            enabled
        }
    }
`);

export const deleteAreaDocument = graphql(`
    mutation DeletePostalCodeArea($id: ID!) {
        deletePostalCodeArea(id: $id) {
            result
            message
        }
    }
`);

export const getChannelPostalCodesDocument = graphql(`
    query GetChannelPostalCodes {
        postalCodes(options: { take: 500 }) {
            items {
                id
                code
                isAnywhere
                areas {
                    id
                    name
                    enabled
                }
            }
            totalItems
        }
    }
`);

export interface PostalCodeArea {
    id: string;
    name: string;
    enabled: boolean;
}

export interface PostalCode {
    id: string;
    code: string;
    isAnywhere: boolean;
    areas: PostalCodeArea[];
}

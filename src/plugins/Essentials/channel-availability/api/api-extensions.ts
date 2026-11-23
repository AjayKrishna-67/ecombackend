import gql from 'graphql-tag';

export const shopApiExtensions = gql`
    enum ChannelLaunchStatus {
        OPENING_SOON
        LAUNCHED
    }

    # Filter enum for the deprecated getAvailableChannels query. Enum (not String)
    # so a bareword like DIRECT parses without quotes, matching the original API.
    enum ChannelType {
        CITY
        BRAND
        DIRECT
    }

    type ChannelAvailability {
        id: ID!
        code: String!
        token: String
        name: String!
        isAvailable: Boolean!
        message: String
        # Free-text: mirrors the channel's customFields.type (CITY, BRAND,
        # DIRECT, National, International, ...). String, not enum, so any admin
        # value serializes instead of erroring on values outside a fixed set.
        type: String!
        launchStatus: ChannelLaunchStatus!
        bannerImage: Asset
    }

    type BrandStorefrontSellerInfo {
        id: ID!
        name: String!
    }

    """
    Lean shape for the "tap a brand → pick/enter a channel" screen. Only the
    fields that screen needs: identify the channel + its entry token. Availability
    flags, launch status and banner are omitted on purpose — the drill already
    filters to deliverable/launched channels, and the banner was shown on the
    switcher card. Use getAvailableChannels for the full flagged list.
    """
    type BrandChannel {
        id: ID!
        code: String!
        name: String!
        token: String
        type: String!
    }

    type BrandStorefront {
        id: ID!
        seller: BrandStorefrontSellerInfo!
        bannerImage: Asset
        launchStatus: ChannelLaunchStatus!
        sortOrder: Int
        "True if at least one of this brand's channels delivers to the pincode passed to brandStorefronts. Always true when no pincode is given."
        isAvailable: Boolean!
        "True if this brand owns an International-typed channel, so the client should show the India/International country toggle. India-only brands are false."
        hasInternational: Boolean!
        "This brand's deliverable channels (with entry tokens) for the pincode + country passed to brandStorefronts. Empty when the brand can't serve the pincode (grey it). Empty when no pincode is given. country narrows region (IN → domestic, else → International)."
        channels: [BrandChannel!]!
    }

    """
    A brand card in the current app's "Switch Store" sheet: brand content plus
    its channels, each already availability-resolved for the given postal code.
    """
    type SwitcherBrand {
        seller: BrandStorefrontSellerInfo!
        bannerImage: Asset
        launchStatus: ChannelLaunchStatus!
        channels: [ChannelAvailability!]!
    }

    extend type Query {
        """
        Get all channels with availability based on postal code.
        Auto-fetches from shipping address if no postal code provided.
        Includes channel type for frontend routing, plus brand launch status
        and banner image for the store switcher. Returns the full flagged list
        (deliverable + undeliverable). For the "tap ONE brand → pick a store"
        drill-down, use brandChannels instead.
        """
        getAvailableChannels(postalCode: String, type: ChannelType): [ChannelAvailability!]!
            @deprecated(reason: "Use brandChannels for a single brand's channels, or switcherBrands for the store switcher.")

        """
        Drill into ONE brand: the deliverable channels for that seller + pincode,
        as a lean list for the "pick a store" screen. Omit sellerId to use the
        brand that owns the current token's channel (your own app); pass sellerId
        to look at a different brand (Switch Store). sellerName is an alternative
        to sellerId for clients that would otherwise hardcode a numeric id: exact
        match on the Seller name, case-insensitive, trimmed, soft-deleted sellers
        excluded. sellerId wins when both are given; an unknown name errors, and a
        duplicated name errors as ambiguous. Omit country to get all regions
        (National + International); pass country (IN / US ...) to narrow. Errors
        "Service Not Available…" when no channel serves the pincode.
        """
        brandChannels(sellerId: ID, sellerName: String, postalCode: String, country: String): [BrandChannel!]!

        """
        Brands to show in the app "Switch Store" sheet, ordered by sortOrder.
        Only brands with "show in switcher" on. launchStatus = OPENING_SOON
        means show the card locked. Pass postalCode to also get isAvailable per
        brand (false = no channel delivers there → grey it "not available in your
        area") and channels (deliverable channels + entry tokens per brand).
        Without postalCode, isAvailable is always true and channels is empty.
        Pass country to narrow channels to a region (IN → domestic, else →
        International); omit for all regions.
        """
        brandStorefronts(postalCode: String, country: String): [BrandStorefront!]!

        """
        Brands for the CURRENT app's switcher, scoped to which app is calling.
        The app is identified by the channel token it sends: the switcher shows
        only the brands that channel's seller (host app) has allowlisted, in the
        configured order, each brand carrying its channels with availability.
        Falls back to all published brands if the host has no allowlist.
        """
        switcherBrands(postalCode: String): [SwitcherBrand!]!
    }
`;

export const adminApiExtensions = gql`
    enum ChannelLaunchStatus {
        OPENING_SOON
        LAUNCHED
    }

    type BrandStorefront {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        seller: Seller!
        bannerImage: Asset
        launchStatus: ChannelLaunchStatus!
        showInStoreSwitcher: Boolean!
        sortOrder: Int
    }

    input UpsertBrandStorefrontInput {
        sellerId: ID!
        bannerImageId: ID
        launchStatus: ChannelLaunchStatus
        showInStoreSwitcher: Boolean
        sortOrder: Int
    }

    extend type Query {
        "All brand storefronts (one per configured seller)."
        brandStorefronts: [BrandStorefront!]!
        "Storefront for a single seller, or null if not yet configured."
        brandStorefront(sellerId: ID!): BrandStorefront
    }

    extend type Mutation {
        "Create or update the storefront config for a seller."
        upsertBrandStorefront(input: UpsertBrandStorefrontInput!): BrandStorefront!
        "Set switcher order; sortOrder becomes each seller's position in the list."
        setBrandStorefrontOrder(sellerIds: [ID!]!): Boolean!
    }
`;

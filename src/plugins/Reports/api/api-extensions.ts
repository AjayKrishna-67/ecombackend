import gql from 'graphql-tag';

export const adminApiExtensions = gql`
    type DeliveredOrdersReportRow {
        orderCode: String!
        orderStatus: String!
        orderAmount: Int!
        netAmount: Int!
        orderPlacedAt: DateTime
        deliveredAt: DateTime!
        channelId: ID!
        channelCode: String!
    }

    type DeliveredOrdersReport {
        items: [DeliveredOrdersReportRow!]!
        totalItems: Int!
        totalOrderAmount: Int!
        totalNetAmount: Int!
    }

    input DeliveredOrdersReportInput {
        from: DateTime!
        to: DateTime!
        channelIds: [ID!]
        skip: Int
        take: Int
    }

    type SalesReportRow {
        orderCode: String!
        orderStatus: String!
        invoiceNo: String
        orderAmount: Int!
        netAmount: Int!
        orderPlacedAt: DateTime
        deliveredAt: DateTime
        channelId: ID!
        channelCode: String!
    }

    type SalesReport {
        items: [SalesReportRow!]!
        totalItems: Int!
        totalOrderAmount: Int!
        totalNetAmount: Int!
    }

    input SalesReportInput {
        from: DateTime!
        to: DateTime!
        channelIds: [ID!]
        skip: Int
        take: Int
    }

    type MonthlyProductFacetSummary {
        id: ID!
        name: String!
    }

    type MonthlyProductSalesReportRow {
        productId: ID!
        productName: String!
        """Facet values the product belongs to. When the facet filter is
        active, only matching facets are listed. The frontend joins these
        names for display and reuses the IDs to populate the filter."""
        facets: [MonthlyProductFacetSummary!]!
        totalQuantitySold: Int!
        totalSalesAmount: Int!
    }

    type MonthlyProductSalesReport {
        items: [MonthlyProductSalesReportRow!]!
        totalItems: Int!
        totalQuantitySold: Int!
        totalSalesAmount: Int!
    }

    input MonthlyProductSalesReportInput {
        from: DateTime!
        to: DateTime!
        channelIds: [ID!]
        facetIds: [ID!]
        facetIdFrom: ID
        facetIdTo: ID
        skip: Int
        take: Int
    }

    type BillPrintDiscount {
        description: String!
        code: String
        source: String!
        amount: Int!
    }

    enum BillPaymentType {
        ONLINE
        COD
    }

    type BillPrintReportRow {
        id: ID!
        pCode: String
        sNo: String
        code: String!
        date: String
        time: String
        billingAddress: String
        customer: String
        address: String
        cellNo: String
        itemName: String!
        tamilName: String
        qty: Int!
        shadowPrice: Int
        rate: Int!
        total: Int!
        subTotal: Int!
        shipping: Int!
        netTotal: Int!
        deliveryTime: String
        cuttingInstructions: String
        paymentMode: String
        ordNo: Int!
        customerId: ID
        pincode: String
        paymentMetadata: String
        paymentMethod: String
        paymentStatus: String
        rewardPointUsed: Int
        couponCode: String
        note: String
        orderModifyNote: String
        invoiceNo: String!
        couponDiscount: Int!
        rewardDiscount: Int!
        originalShipping: Int!
        discounts: [BillPrintDiscount!]!
        loyaltyPointsUsed: Int
        loyaltyPointsAvailable: Int
        paymentType: BillPaymentType!
        adminMarkedAsPaid: Boolean!
        hsnCode: String
        taxRate: Float!
        taxAmount: Int!
        priceBeforeTax: Int!
        totalTaxAmount: Int!
        """
        Line total after the coupon's item-level discounts (free product,
        percentage off a product, buy X get Y), incl. tax. Order-level coupon
        discounts are not in it. Null on results cached before this field.
        """
        discountedTotal: Int
        """A coupon gift product: it has a price but the customer pays nothing."""
        isFree: Boolean
    }

    type BillPrintReport {
        items: [BillPrintReportRow!]!
        totalItems: Int!
    }

    input BillPrintReportInput {
        from: DateTime!
        to: DateTime!
        channelIds: [ID!]
        states: [String!]
        skip: Int
        take: Int
    }

    "How a purchase quantity is expressed. Decides the maths, not just the label."
    enum PurchaseUnitKind {
        "Weighed goods. Quantity is kilograms: 15 orders of a 500 g pack = 7.5."
        WEIGHT
        "Liquids. Quantity is litres."
        VOLUME
        "Counted packs. Quantity is whole units — 5 boxes of paneer = 5, NOT 2.5 kg."
        COUNT
    }

    """
    Whether a row speaks for a whole product or for one variant of it.
    Variant-scoped when the product tracks stock per variant — the merchant
    already treats those as distinct things (yoghurt flavours). A weight-pool
    product rolls every pack size into one row, weighed or counted: three pack
    sizes of tomato are one purchase, and so are amla 10 nos and 25 nos.
    """
    enum PurchaseRowScope {
        PRODUCT
        VARIANT
    }

    type PurchaseListRow {
        "Section from FacetValue.purchaseOrdNo (lowest of the product's tags). Null sorts last."
        ordNo: Int
        """
        Tamil first, English only as a rescue. PRODUCT rows use
        Product.localName ?? Product.name; VARIANT rows use
        ProductVariant.localName ?? ProductVariant.name.
        """
        label: String!
        """
        Rows that print the same label in the same unit are merged: the
        catalogue holds the same produce created more than once as separate
        products. A merged row is PRODUCT-scoped and carries the first
        product's id.
        """
        productId: ID!
        "Set on a VARIANT row, null on a PRODUCT row."
        variantId: ID
        scope: PurchaseRowScope!
        "Kilograms for WEIGHT, litres for VOLUME, whole units for COUNT."
        totalQty: Float!
        unitKind: PurchaseUnitKind!
        "What to print beside the number: kg / l / Pcs."
        unitLabel: String!
        "Distinct variants summed into this row. Always 1 on a VARIANT row."
        variantCount: Int!
        """
        True when any line in this row had no usable measurement. Part of the
        quantity is then an ORDERED COUNT (or, on a weighed row, missing), not a
        computed figure — show it differently, or a guess is indistinguishable
        from a fact.
        """
        incomplete: Boolean!
    }

    type PurchaseListReport {
        rows: [PurchaseListRow!]!
        "Distinct orders behind the numbers."
        orderCount: Int!
        "Order lines read. Unpaginated by design — a truncated purchase list under-orders food."
        lineCount: Int!
        "Rows where some of the quantity is an assumption rather than a measurement."
        incompleteCount: Int!
    }

    input PurchaseListReportInput {
        "Start of the order-placed window (inclusive)."
        from: DateTime!
        "End of the order-placed window (inclusive)."
        to: DateTime!
        """
        Channels to aggregate. Omit for the caller's active channel. Do NOT pass
        __default_channel__ alongside a city channel — every order belongs to
        both, and including both counts each order once per channel.
        """
        channelIds: [ID!]
        "Order states to include. Defaults to outstanding orders (excludes Delivered, Cancelled, AddingItems, CancellationRequested)."
        states: [String!]
    }

    extend type Query {
        purchaseListReport(input: PurchaseListReportInput!): PurchaseListReport!
        deliveredOrdersReport(input: DeliveredOrdersReportInput!): DeliveredOrdersReport!
        salesReport(input: SalesReportInput!): SalesReport!
        monthlyProductSalesReport(input: MonthlyProductSalesReportInput!): MonthlyProductSalesReport!
        billPrintReport(input: BillPrintReportInput!): BillPrintReport!
        availableOrderStates: [String!]!
    }
`;

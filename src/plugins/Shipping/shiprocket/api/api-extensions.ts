// src/plugins/shiprocket/api-extensions.ts

import gql from 'graphql-tag';

// We don't need the 'id' argument just to test the connection.
const shipRocketAdminApiExtensions = gql`
  type PickupAddress {
    id: Int!
    pickup_location: String!
    address: String!
    address_2: String!
    city: String!
    state: String!
    country: String!
    pin_code: String!
    phone: String!
    name: String!
    lat: String!
    long: String!
    is_primary_location: Int!
    status: Int!
  }

  type QuickRate {
    courier_name: String!
    rates: Float!
    rto_rates: Float!
    etd: String!
    etd_hours: Int!
    distance: Float!
  }

  type ShiprocketOrderProduct {
    id: Int!
    name: String!
    sku: String!
    quantity: Int!
    price: Float!
    selling_price: Float!
  }

  type ShiprocketOrderShipment {
    id: Int!
    awb: String
    courier: String!
    courier_id: String!
    status: String!
    etd: String!
    delivered_date: String!
    weight: Float!
    dimensions: String!
    length: Int!
    breadth: Int!
    height: Int!
  }

  type ShiprocketPickupAddress {
    id: Int!
    pickup_code: String!
    name: String!
    phone: String!
    address: String!
    address_2: String!
    city: String!
    state: String!
    country: String!
    lat: String!
    long: String!
  }

  type ShiprocketOrderDetails {
    id: Int!
    channel_order_id: String!
    status: String!
    status_code: Int!
    customer_name: String!
    customer_email: String!
    customer_phone: String!
    customer_address: String!
    customer_address_2: String!
    customer_city: String!
    customer_state: String!
    customer_pincode: String!
    customer_country: String!
    pickup_location: String!
    pickup_location_id: Int!
    payment_method: String!
    total: Float!
    net_total: String!
    cod: Int!
    created_at: String!
    updated_at: String!
    order_date: String!
    shipments: ShiprocketOrderShipment!
    products: [ShiprocketOrderProduct!]!
    pickup_address: ShiprocketPickupAddress!
  }

  input QuickRateInput {
    pickup_postcode: Int!
    delivery_postcode: Int!
    lat_from: Float!
    long_from: Float!
    lat_to: Float!
    long_to: Float!
  }

  input AddPickupAddressInput {
    pickup_location: String!
    name: String!
    phone: String!
    address: String!
    address_2: String
    city: String!
    state: String!
    country: String!
    pin_code: String!
    lat: String!
    long: String!
  }

  type ShiprocketQuickTrackActivity {
    date: String!
    status: String!
    activity: String!
    location: String!
    srStatusLabel: String
  }

  type ShiprocketQuickTracking {
    shipmentId: Int!
    awb: String
    courierName: String
    currentStatus: String
    origin: String
    destination: String
    pickupDate: String
    deliveredDate: String
    etd: String
    trackUrl: String
    error: String
    activities: [ShiprocketQuickTrackActivity!]!
  }

  extend type Query {
    testShiprocketAuth: Boolean!
    getShiprocketPickupAddresses: [PickupAddress!]!
    getShiprocketQuickRates(input: QuickRateInput!): [QuickRate!]!
    getShiprocketOrderDetails(orderId: Int!): ShiprocketOrderDetails
    getShiprocketDetailsByVendureOrder(vendureOrderId: ID!): [ShiprocketOrderDetails!]!
    getShiprocketQuickTracking(shipmentId: Int!): ShiprocketQuickTracking
  }

  type AssignAwbResult {
    success: Boolean!
    awb_code: String
    courier_name: String
    message: String
  }

  extend type Mutation {
    cancelShiprocketQuickOrder(orderIds: [Int!]!): Boolean!
    assignShiprocketAwb(shipmentId: Int!, courierId: Int): AssignAwbResult!
  }
`;

export const adminApiExtensions = gql`
  ${shipRocketAdminApiExtensions}
`;


const shipRocketShopApiExtensions = gql`
    type ShippingOption {
        id: String!
        name: String!
        description: String!
        price: Money!
        estimatedDeliveryDays: String!
        courierName: String!
        etd: String!
        trackingAvailable: Boolean!
        codAvailable: Boolean!
    }

    input ShippingRateInput {
        pickupPostcode: String!
        deliveryPostcode: String!
        weight: Float!
        orderValue: Money!
        enableCOD: Boolean
    }

    extend type Query {
        getShippingOptions(input: ShippingRateInput!): [ShippingOption!]!
    }
`;

export const shopApiExtensions = gql`
    ${shipRocketShopApiExtensions}
`;

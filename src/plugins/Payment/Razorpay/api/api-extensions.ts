// src/plugins/Payment/Razorpay/api/api-extensions.ts

import { gql } from 'graphql-tag';

export const shopApiExtensions = gql`
  type GenerateRazorpayOrderIdResult {
      success: Boolean!
      razorpayOrderId: String
      amount: Int
      currency: String
      keyId: String
      errorMessage: String
  }

type RazorpayPaymentAttempt {
      id: String!
      status: String!
      amount: Int
      method: String
      createdAt: String    # We will send ISO Date string
      errorReason: String  # To show why it failed
  }

  # 2. Update the Status object to include the list
  type RazorpayOrderStatus {
      status: String
      attempts: Int
      amountPaid: Int
      amountDue: Int
      razorpayOrderId: String
      # Add this line:
      history: [RazorpayPaymentAttempt]
  }

  type CancelRazorpayPaymentResult {
      success: Boolean!
      reverted: Boolean
      state: String
      errorMessage: String
  }

  extend type Mutation {
      generateRazorpayOrderId(orderId: ID!): GenerateRazorpayOrderIdResult!
      cancelRazorpayPayment(orderId: ID!): CancelRazorpayPaymentResult!
  }

  # New Query
  extend type Query {
      getRazorpayOrderStatus(orderId: ID!): RazorpayOrderStatus
  }
`;

export const adminApiExtensions = gql`
  type RazorpayPaymentAttempt {
      id: String!
      status: String!
      amount: Int
      method: String
      createdAt: String
      errorReason: String
  }

  type RazorpayOrderStatus {
      status: String
      attempts: Int
      amountPaid: Int
      amountDue: Int
      razorpayOrderId: String
      history: [RazorpayPaymentAttempt]
  }

  type SettleOrderPaymentResult {
      success: Boolean!
      message: String!
      state: String
  }

  type RazorpayAlert {
      orderId: ID!
      orderCode: String!
      reason: String!
      stuckSince: String!
  }

  extend enum HistoryEntryType {
      RAZORPAY_WEBHOOK
  }

  extend type Query {
      getRazorpayOrderStatus(orderId: ID!): RazorpayOrderStatus
      getRazorpayAlerts: [RazorpayAlert!]!
  }

`;
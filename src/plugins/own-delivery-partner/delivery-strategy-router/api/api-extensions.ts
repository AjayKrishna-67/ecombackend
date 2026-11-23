import gql from 'graphql-tag';

export const adminApiExtensions = gql`
    type DeliveryPerson {
        id: ID!
        firstName: String!
        lastName: String!
        emailAddress: String!
        phoneNumber: String
    }

    type DeliveryFulfillment {
        id: ID!
        state: String!
        trackingCode: String
        method: String!
        createdAt: DateTime!
        updatedAt: DateTime!
        lines: [FulfillmentLine!]!
    }

    type DeliveryAssignmentInfo {
        fulfillmentId: ID!
        state: String!
        deliveryPersonName: String!
        deliveryPersonPhone: String
        createdAt: DateTime!
    }

    input PaymentCollectionInput {
        """Cash or QR - required for offline (COD) orders"""
        paymentCollectionMethod: String!
        """Amount collected in minor currency units (paise)"""
        collectedAmount: Int!
        """Required when collectedAmount differs from order total - reason for shortfall/excess"""
        collectionNote: String
    }

    type DeliveryFulfillmentWithPayment {
        id: ID!
        state: String!
        trackingCode: String
        method: String!
        createdAt: DateTime!
        updatedAt: DateTime!
        lines: [FulfillmentLine!]!
        orderCode: String!
        orderTotal: Int!
        """Payment handler code: razorpay-payment or offline"""
        paymentMethod: String!
        """Cash, QR, or Online (null if not yet delivered)"""
        paymentCollectionMethod: String
        collectedAmount: Int
        """Reason provided when collected amount differs from order total"""
        collectionNote: String
        customerName: String
        shippingAddress: String
    }

    input DeliveryOrderFilterParameter {
        id: IDOperators
        createdAt: DateOperators
        updatedAt: DateOperators
        orderPlacedAt: DateOperators
        code: StringOperators
        state: StringOperators
        active: BooleanOperators
        totalWithTax: NumberOperators
        total: NumberOperators
        subTotal: NumberOperators
        subTotalWithTax: NumberOperators
        shipping: NumberOperators
        shippingWithTax: NumberOperators
        totalQuantity: NumberOperators
        type: StringOperators
        customerLastName: StringOperators
        transactionId: StringOperators
        aggregateOrderId: IDOperators
        platform: StringOperators
        deviceMedium: StringOperators
        razorpayOrderId: StringOperators
        razorpayPaymentId: StringOperators
        isPaymentWindowOpen: BooleanOperators
        invoiceNo: StringOperators
        cancellationReason: StringOperators
        otherInstructions: StringOperators
        loyaltyPointsUsed: NumberOperators
        loyaltyPointsEarned: NumberOperators
    }

    input DeliveryOrderSortParameter {
        id: SortOrder
        createdAt: SortOrder
        updatedAt: SortOrder
        orderPlacedAt: SortOrder
        code: SortOrder
        state: SortOrder
        totalWithTax: SortOrder
        total: SortOrder
        subTotal: SortOrder
        subTotalWithTax: SortOrder
        shipping: SortOrder
        shippingWithTax: SortOrder
        totalQuantity: SortOrder
        customerLastName: SortOrder
        transactionId: SortOrder
        platform: SortOrder
        deviceMedium: SortOrder
        razorpayOrderId: SortOrder
        razorpayPaymentId: SortOrder
        invoiceNo: SortOrder
        cancellationReason: SortOrder
        otherInstructions: SortOrder
        loyaltyPointsUsed: SortOrder
        loyaltyPointsEarned: SortOrder
    }

    input DeliveryOrderListOptions {
        shippingMethodId: ID
        postalCode: String
        area: String
        search: String
        skip: Int
        take: Int
        filter: DeliveryOrderFilterParameter
        sort: DeliveryOrderSortParameter
        filterOperator: LogicalOperator
        """
        When set, Delivered orders are only returned if their delivery fulfillment
        reached Delivered on or after this instant. Shipped/OutforDelivery orders are
        always returned. Omit to include all Delivered (no window).
        """
        deliveredSince: DateTime
    }

    type DeliveryOrderList {
        items: [Order!]!
        totalItems: Int!
    }

    # ─── Unified Delivery Report (role-aware) ───

    input DeliveryReportInput {
        """Start of date range (inclusive)"""
        dateFrom: DateTime!
        """End of date range (inclusive)"""
        dateTo: DateTime!
        """Pagination: number of fulfillment details to skip (default 0)."""
        skip: Int
        """Pagination: number of fulfillment details to return (default 50)."""
        take: Int
        """Optional: filter by a specific delivery person ID. Admin/Accountant can use this to drill down; delivery persons are always scoped to their own ID."""
        deliveryPersonId: ID
    }

    type DeliveryFulfillmentDetail {
        fulfillmentId: ID!
        orderCode: String!
        orderTotal: Int!
        paymentCollectionMethod: String
        collectedAmount: Int
        """Cash portion for Cash+QR orders (in paise). 0 for pure Cash/QR/Online."""
        qrCashAmount: Int
        """QR portion for Cash+QR orders (in paise). 0 for pure Cash/Online."""
        qrAmount: Int
        """Reason provided when collected amount differs from order total"""
        collectionNote: String
        deliveredAt: DateTime
        deliveryPersonName: String!
        deliveryPersonId: String!
        customerName: String
    }

    type DeliveryPersonReportSummary {
        deliveryPersonId: String!
        deliveryPersonName: String!
        deliveryPersonPhone: String
        totalDeliveries: Int!
        cashCount: Int!
        qrCount: Int!
        onlineCount: Int!
        paymentLinkCount: Int!
        totalCashAmount: Int!
        totalQrAmount: Int!
        totalOnlineAmount: Int!
        totalPaymentLinkAmount: Int!
        """Populated when viewing a single DP (DP self or accountant drill-down). Empty for all-DP overview."""
        fulfillments: [DeliveryFulfillmentDetail!]!
    }

    # ─── QR Code Payment Types ───

    type DeliveryQrCode {
        """Razorpay QR code ID"""
        qrCodeId: String!
        """URL to the QR code image (PNG)"""
        imageUrl: String!
        """Amount the QR is for (in paise)"""
        amount: Int!
        """Cash portion already recorded (in paise), 0 if pure QR"""
        cashAmount: Int!
        """QR status: active, closed, paid"""
        status: String!
        """ISO timestamp when the QR expires"""
        closesAt: String
    }

    input GenerateDeliveryQrInput {
        """Fulfillment ID to generate QR for"""
        fulfillmentId: ID!
        """Optional: cash amount already collected (in paise). QR will be for the remainder."""
        cashAmount: Int
    }

    # ─── Payment Link Types ───

    type DeliveryPaymentLink {
        """Razorpay Payment Link ID"""
        paymentLinkId: String!
        """Short URL for the payment link"""
        shortUrl: String!
        """Amount the link is for (in paise)"""
        amount: Int!
        """Payment Link status: created, paid, cancelled, expired"""
        status: String!
        """Phone number the link was sent to"""
        customerPhone: String!
    }

    input CreateDeliveryPaymentLinkInput {
        """Fulfillment ID to create payment link for"""
        fulfillmentId: ID!
        """10-digit Indian mobile number to send the payment link to"""
        customerPhone: String!
    }

    type DeliveryReportResult {
        """Caller's effective role for this channel: DELIVERY_PERSON, ACCOUNTANT, or ADMIN"""
        callerRole: String!
        """Per-delivery-person summaries (aggregated via SQL)"""
        summaries: [DeliveryPersonReportSummary!]!
        grandTotalDeliveries: Int!
        grandTotalCashCount: Int!
        grandTotalQrCount: Int!
        grandTotalOnlineCount: Int!
        grandTotalPaymentLinkCount: Int!
        grandTotalCashAmount: Int!
        grandTotalQrAmount: Int!
        grandTotalOnlineAmount: Int!
        grandTotalPaymentLinkAmount: Int!
    }

    # ─── Live Delivery Tracking (rides, heartbeats, fleet) ───

    type DeliveryRideInfo {
        id: ID!
        administratorId: ID!
        orderId: ID!
        orderCode: String!
        startedAt: DateTime!
        """Null while the ride is in progress — an "open ride"."""
        deliveredAt: DateTime
        """Cumulative odometer for this ride, in meters."""
        distanceMeters: Int!
    }

    enum DriverFleetState {
        OUT_FOR_DELIVERY
        ACTIVE
        INACTIVE
    }

    type DriverFleetStatus {
        administratorId: ID!
        name: String!
        phoneNumber: String
        """OUT_FOR_DELIVERY = open ride; ACTIVE = fresh heartbeat with GPS on; INACTIVE = silence or GPS off."""
        state: DriverFleetState!
        lat: Float
        lng: Float
        gpsOn: Boolean!
        lastHeartbeatAt: DateTime
        """SUM of today's ride distances, in meters."""
        metersToday: Int!
        activeOrderId: ID
        activeOrderCode: String
    }

    input DriverHeartbeatInput {
        lat: Float
        lng: Float
        """Whether the phone currently has GPS permission + signal. Send a final gpsOn:false beat on logout."""
        gpsOn: Boolean!
        """Cumulative meters for the open ride. Idempotent — the server keeps the max, so a lost ping loses nothing."""
        rideDistanceMeters: Int
        """Which order the km belongs to (needed only when carrying multiple orders at once)."""
        orderId: ID
    }

    type DriverHeartbeatAck {
        ok: Boolean!
        serverTime: DateTime!
    }

    """One order assignment (fulfillment) of a delivery person — fleet detail page."""
    type DriverAssignedOrder {
        fulfillmentId: ID!
        orderId: ID!
        orderCode: String!
        """Fulfillment state: Created/Pending/Shipped = assigned, not started; OutforDelivery; Delivered; Cancelled."""
        state: String!
        """When the order was assigned (fulfillment created)."""
        assignedAt: DateTime!
        """Null unless state is Delivered."""
        deliveredAt: DateTime
        customerName: String
        """Area from the shipping address (falls back to city)."""
        area: String
        """Order total incl. shipping, in paise."""
        orderTotal: Int!
    }

    extend type Query {
        """
        Get all administrators with the DeliveryPerson role.
        Requires CustomFulfillment permission (Admin only).
        """
        deliveryPersons: [DeliveryPerson!]!

        """
        Get a single delivery person by ID.
        Requires CustomFulfillment permission (Admin only).
        """
        deliveryPerson(id: ID!): DeliveryPerson

        """
        Get all fulfillments assigned to a specific delivery person.
        Requires CustomFulfillment permission (Admin only).
        """
        deliveryPersonFulfillments(deliveryPersonId: ID!): [DeliveryFulfillment!]!

        """
        Get orders filtered by shipping method and/or postal code.
        Returns orders in: PaymentAuthorized, PaymentSettled.
        Requires CustomFulfillment permission (Admin only).
        """
        deliveryOrders(options: DeliveryOrderListOptions): DeliveryOrderList!

        """
        Get delivery assignment info for all fulfillments of an order.
        Returns delivery person details from internal custom fields.
        """
        orderDeliveryAssignments(orderId: ID!): [DeliveryAssignmentInfo!]!

        """
        Get the logged-in delivery person's own profile.
        Requires TransitionToOutForDelivery permission (DP accessible).
        """
        myDeliveryProfile: DeliveryPerson

        """
        Get all fulfillments assigned to the currently logged-in delivery person.
        Requires TransitionToOutForDelivery permission (DP accessible).
        """
        myDeliveryFulfillments: [DeliveryFulfillment!]!

        """
        Get fulfillments assigned to the logged-in DP with order payment info.
        Requires TransitionToOutForDelivery permission (DP accessible).
        """
        myDeliveryFulfillmentsWithPayment: [DeliveryFulfillmentWithPayment!]!

        """
        Order-centric list of orders assigned to the logged-in delivery person.
        Returns distinct Orders (paginated, real totalItems), scoped to orders that
        have a fulfillment assigned to this DP in Shipped/OutforDelivery/Delivered.
        Prefer this over myDeliveryFulfillments for the orders list — no per-line
        order duplication and no client-side grouping.
        Requires TransitionToOutForDelivery permission (DP accessible).
        """
        myDeliveryOrders(options: DeliveryOrderListOptions): DeliveryOrderList!

        """
        Unified delivery report with permission-based scoping.
        - Has ViewDeliveryReports permission: returns all DPs overview with summaries.
        - No ViewDeliveryReports permission (delivery person): returns only their own report with fulfillment details (paginated).
        Requires TransitionToOutForDelivery OR ViewDeliveryReports OR CustomFulfillment permission.
        """
        deliveryReport(input: DeliveryReportInput!): DeliveryReportResult!

        """
        Get current QR code for a fulfillment (if any).
        Requires TransitionToDelivered permission.
        """
        deliveryQrCode(fulfillmentId: ID!): DeliveryQrCode

        """
        The logged-in delivery person's most recent open ride, or null.
        Powers ride-resume after logout / app kill.
        Requires TransitionToOutForDelivery permission (DP accessible).
        """
        activeRideForMe: DeliveryRideInfo

        """
        Live fleet status of every delivery person on the channel (state, last
        position, km today). Poll this from the fleet page.
        Requires ViewDeliveryReports or CustomFulfillment permission.
        """
        driverStatuses: [DriverFleetStatus!]!

        """
        Ride history for one delivery person in a date range (fleet detail page).
        Requires ViewDeliveryReports or CustomFulfillment permission.
        """
        driverRides(deliveryPersonId: ID!, dateFrom: DateTime!, dateTo: DateTime!): [DeliveryRideInfo!]!

        """
        Orders one delivery person held in a date range (fleet detail page):
        assigned by the end of the range and not delivered/cancelled before its
        start — i.e. assigned in the range, closed in the range, or still open.
        Newest first. Requires ViewDeliveryReports or CustomFulfillment permission.
        """
        driverAssignedOrders(deliveryPersonId: ID!, dateFrom: DateTime!, dateTo: DateTime!): [DriverAssignedOrder!]!

        """
        One-time ticket (60 s TTL) for the fleet Socket.IO connection at
        /fleet-io. Auth + channel scoping happen here; the socket handshake
        just consumes the ticket. Requires ViewDeliveryReports or
        CustomFulfillment permission.
        """
        fleetSocketTicket: String!

        """
        One-time ticket (60 s TTL) for the DRIVER ride-streaming socket at
        /fleet-io. While riding, the app streams GPS fixes over this socket
        (~every 2.5 s) instead of 20 s heartbeats; the gateway relays them
        live to the channel's fleet viewers.
        Requires TransitionToOutForDelivery permission (DP accessible).
        """
        driverSocketTicket: String!
    }

    input DeliveryFulfillmentLineInput {
        orderLineId: ID!
        quantity: Int!
    }

    input CreateDeliveryFulfillmentInput {
        lines: [DeliveryFulfillmentLineInput!]!
        deliveryPersonId: ID!
    }

    extend type Mutation {
        """
        Create a fulfillment with a delivery person assignment.
        Requires CustomFulfillment permission.
        """
        createDeliveryFulfillment(input: CreateDeliveryFulfillmentInput!): Fulfillment!

        """
        Transition a fulfillment to OutforDelivery state.
        Requires TransitionToOutForDelivery permission.
        """
        transitToOutForDelivery(fulfillmentId: ID!): Fulfillment!

        """
        Transition a fulfillment to Delivered state with optional payment collection.
        For offline (COD) orders, paymentCollection is required (Cash or QR).
        For online (razorpay) orders, paymentCollection is optional (auto-set to Online).
        Requires TransitionToDelivered permission.
        """
        transitToDelivered(fulfillmentId: ID!, paymentCollection: PaymentCollectionInput): Fulfillment!

        """
        Generate a Razorpay QR code for COD payment collection during delivery.
        Fulfillment must be in OutforDelivery state.
        If cashAmount is provided, QR is generated for (orderTotal - cashAmount).
        Idempotent: closes any existing active QR before creating a new one.
        Requires TransitionToDelivered permission.
        """
        generateDeliveryQrCode(input: GenerateDeliveryQrInput!): DeliveryQrCode!

        """
        Check QR payment status via Razorpay API (polling fallback).
        If paid, auto-transitions fulfillment to Delivered.
        Requires TransitionToDelivered permission.
        """
        checkDeliveryQrStatus(fulfillmentId: ID!): DeliveryQrCode!

        """
        Close/cancel an active QR code. Use when customer decides to pay all-cash instead.
        Requires TransitionToDelivered permission.
        """
        closeDeliveryQrCode(fulfillmentId: ID!): DeliveryQrCode!

        """
        Create a Razorpay Payment Link and send via SMS to the given phone number.
        Fulfillment must be in OutforDelivery state. Order must be COD.
        Idempotent: cancels any existing active payment link before creating a new one.
        Requires TransitionToDelivered permission.
        """
        createDeliveryPaymentLink(input: CreateDeliveryPaymentLinkInput!): DeliveryPaymentLink!

        """
        Check Payment Link status via Razorpay API (polling fallback).
        If paid, auto-transitions fulfillment to Delivered.
        Requires TransitionToDelivered permission.
        """
        checkDeliveryPaymentLinkStatus(fulfillmentId: ID!): DeliveryPaymentLink!

        """
        Cancel an active Payment Link.
        Requires TransitionToDelivered permission.
        """
        cancelDeliveryPaymentLink(fulfillmentId: ID!): DeliveryPaymentLink!

        """
        Presence ping from the driver's phone (~every 20 s while the app is open).
        Carries last position, GPS state, and the open ride's cumulative odometer.
        Requires TransitionToOutForDelivery permission (DP accessible).
        """
        driverHeartbeat(input: DriverHeartbeatInput!): DriverHeartbeatAck!

        """
        Open a DeliveryRide for the given order (idempotent — returns the existing
        open ride if one exists). Call alongside transitToOutForDelivery.
        Rides are also auto-opened by the fulfillment state event as a safety net.
        Requires TransitionToOutForDelivery permission (DP accessible).
        """
        startDeliveryRide(orderId: ID!): DeliveryRideInfo!

        """
        Close the open ride for the given order, stamping deliveredAt and the final
        odometer. Call alongside transitToDelivered.
        Requires TransitionToOutForDelivery permission (DP accessible).
        """
        completeDeliveryRide(orderId: ID!, finalDistanceMeters: Int): DeliveryRideInfo!
    }
`;

export const shopApiExtensions = gql`
    """What the order's owner may see about a delivery in progress."""
    type OrderDeliveryTracking {
        """True while a delivery person is out with this order."""
        active: Boolean!
        """Last known position of the delivery person. Null when not active or not yet reported."""
        lat: Float
        lng: Float
        """When that position was last reported."""
        updatedAt: DateTime
        """
        One-time ticket (60 s TTL) for the Socket.IO connection at /fleet-io
        (handshake auth: { ticket }). The socket joins only THIS order's room and
        receives 'delivery-live' ({ lat, lng, heading, at }) as the rider moves,
        'delivery-route' ({ encodedPolyline, at }) when the road route is
        recomputed (driver rerouted), and 'delivery-status'
        ({ status: 'delivered' | 'cancelled' }) when the delivery ends.
        Null when not active.
        """
        socketTicket: String
        """
        Encoded road route (Google polyline) from the delivery person to the
        shipping address — the same line the delivery person's own map shows.
        Null when not active, when the address has no map pin, or when routing
        is unavailable.
        """
        routePolyline: String
    }

    """The delivery person bringing an order, as its owner may see them."""
    type OrderDeliveryPerson {
        name: String!
        """Number to call them on. Null when none is recorded."""
        phoneNumber: String
        """
        OTP the customer gives the rider to confirm the delivery. Null when
        Adloggs has not sent one.
        """
        deliveryOtp: String
    }

    extend type Order {
        """
        The Adloggs rider bringing this order, from pickup until delivery.
        Null at every other stage and for every other carrier — our own
        delivery staff are never given out.
        """
        deliveryPerson: OrderDeliveryPerson
    }

    extend type Query {
        """
        Live position of the delivery person bringing one of the customer's orders.
        Same access rule as orderByCode: the order's owner, or the guest who placed
        it within the grace window.
        """
        orderDeliveryTracking(orderCode: String!): OrderDeliveryTracking!
    }
`;

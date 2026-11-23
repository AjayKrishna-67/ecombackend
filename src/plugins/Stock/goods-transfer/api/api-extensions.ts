import gql from 'graphql-tag';

/**
 * Admin-API schema for the GoodsTransferPlugin.
 *
 * One mutation per action, named for the action: create / update / delete build the
 * entry, then confirm / dispatch / receive move it. Each is separately permissioned,
 * so what a role can do is readable straight off the schema.
 *
 * The flow is strictly forward — there is no revert. Correcting a load is an EDIT in
 * place (updateGoodsTransfer works at DRAFT, CONFIRMED and DISPATCHED), so a transfer
 * never moves backwards and its number is never reissued.
 *
 * Reads are one-per-screen: goodsTransfers backs the list, every report tab and the
 * search box; goodsTransfer carries a transfer's lines, live stock, audit trail and
 * damage, so no screen has to fan out.
 *
 * Conventions: a pooled product's quantity is STORED as an integer in its own BASE
 * unit — grams, millilitres or pieces — and poolUnit says which. It is ENTERED as
 * poolQty, in that product's display unit (1.5 for 1.5 kg, 30 for 30 pieces), and
 * read back the same way. Exactly one of pieces/pool quantity per line.
 *
 * weightKg and weightGrams still work and still mean kilograms and grams, but ONLY
 * on a product that is actually weighed; on a counted or volume pool they are
 * refused rather than reinterpreted, so a client that predates poolQty cannot put a
 * thousand pieces into a pool that wanted ten. New callers should send poolQty.
 *
 * Pool vs pieces is decided solely by the product's own stock flag, and the pool's
 * unit solely by its measurement option — never by the caller.
 *
 * NOTE: descriptions here must not contain backticks — this whole schema is a
 * TypeScript template literal, and a stray backtick ends it mid-document.
 */
export const adminApiExtensions = gql`
    enum TransferState {
        "A request the receiving branch is still writing — nobody else can see it"
        REQUEST_DRAFT
        "Asked for by the receiving branch — becomes DRAFT when the source accepts it"
        REQUESTED
        DRAFT
        CONFIRMED
        DISPATCHED
        RECEIVED
    }

    enum DamageState {
        DRAFT
        PENDING_APPROVAL
        APPROVED
        REJECTED
    }

    """
    Which slice of transfers to show. The first four are transfer states; the damage
    ones select transfers by the state of the claims raised against them, so one
    screen with one set of tabs covers both.

    A transfer can match more than one damage value at once, because claims are raised
    and decided one at a time: a load with one approved claim and one still waiting
    belongs under both.
    """
    enum TransferReportStatus {
        ALL
        "Requests this branch has written but not sent — its own rows only"
        REQUEST_DRAFT
        "Item requests still waiting for the source branch to accept them"
        REQUESTED
        DRAFT
        CONFIRMED
        DISPATCHED
        RECEIVED
        "Transfers holding at least one line the expiry sweep has flagged"
        EXPIRING_SOON
        "At least one claim still awaiting a decision"
        DAMAGE_PENDING
        "At least one claim decided — approved OR rejected"
        DAMAGE_DECIDED
        "At least one claim approved"
        DAMAGE_APPROVED
        "At least one claim rejected"
        DAMAGE_REJECTED
    }

    type GoodsTransferLine implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        productId: ID!
        "Null for pool (weight) lines — pool entry is product-level"
        productVariantId: ID
        productName: String!
        sku: String!
        "true = product-level pool (poolQty); false = pieces (quantityPcs)"
        isPooled: Boolean!
        """
        What this line's pool is counted in: kg, litre or piece. Null on a PCS line,
        and on rows written before the unit was recorded — treat null as unknown
        rather than as kilograms.
        """
        poolUnit: String
        quantityPcs: Int
        """
        The stored pool quantity, an integer in the pool's BASE unit (grams, millilitres
        or pieces) — the exact value all stock math uses. Read poolUnit alongside it.
        """
        weightGrams: Int
        """
        The pool quantity in the line's own unit — 1.5 for 1.5 kg, 30 for 30 pieces.
        Derived, never stored. This is what display and edit screens should use.
        """
        poolQty: Float
        """
        The same quantity in kg. Null unless this line is actually weighed — a counted
        pool has no weight, and reporting one would invent a number nobody measured.
        Prefer poolQty, which is correct for every pool.
        """
        weightKg: Float
        "Destination stock for this product right now — pool base units when pooled, else pieces. Null until the transfer is confirmed."
        currentStock: Int
        "Quantity already claimed as damaged against this line (pending + approved)"
        damagedQty: Int!
    }

    type TransferAuditEntry implements Node {
        id: ID!
        createdAt: DateTime!
        action: String!
        fromState: String
        toState: String
        "Name of the admin who performed the action (snapshot)"
        userName: String!
        data: JSON
    }

    type TransferAuditList {
        items: [TransferAuditEntry!]!
        totalItems: Int!
    }

    "One damaged product inside a request — its own quantity, percentage and photos"
    type DamageRequestLine implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        "The transfer line this damage was recorded against"
        lineId: ID!
        productName: String!
        sku: String!
        isPooled: Boolean!
        "What the damaged pool quantity is counted in: kg, litre or piece. Null on a PCS line."
        poolUnit: String
        damagedPcs: Int
        "Damaged pool quantity as stored, an integer in the pool's base unit"
        damagedGrams: Int
        "The damaged pool quantity in the line's own unit. Derived, never stored."
        damagedPoolQty: Float
        "The same damaged quantity in kg. Null unless the product is actually weighed."
        damagedKg: Float
        "Received quantity of the transfer line when this was raised"
        receivedQtySnapshot: Int!
        "Auto-calculated indicator — also decides whether a photo was required (>= 5%)"
        damagePercent: String
        "Optional free text for this product"
        note: String
        """
        Evidence for this product. Core Assets, so the printable URL comes back in the
        same call — ask for source, preview or name directly, with no second lookup.
        """
        photos: [Asset!]!
    }

    "A damage claim covering ONE OR MORE products of a single transfer"
    type DamageRequest implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        transferId: ID!
        "The ONE identifier for this claim, e.g. DMG-M-0007|26-27. Issued when it is raised."
        damageNumber: String!
        state: DamageState!
        remarks: String
        pdfAssetId: ID
        createdByName: String!
        approvedByName: String
        approvedAt: DateTime
        lines: [DamageRequestLine!]!
    }

    type GoodsTransfer implements Node {
        id: ID!
        createdAt: DateTime!
        updatedAt: DateTime!
        "The ONE identifier for this transfer — document, lists and reports all use it"
        transferNumber: String!
        state: TransferState!
        sourceChannelId: ID!
        destinationChannelId: ID!
        "Human-readable source channel code (e.g. Madurai)"
        sourceChannelCode: String!
        "Human-readable destination channel code (e.g. Kochi)"
        destinationChannelCode: String!
        "Asset id of the generated transfer document, identified by transferNumber"
        pdfAssetId: ID
        """
        The transfer document itself, so the printable URL comes back in the SAME call
        that produced it — confirmGoodsTransfer returns this, and the driver's paper can
        be opened straight away with no second query. An id alone cannot be printed.
        """
        pdfAsset: Asset
        remarks: String
        driverName: String
        driverPhone: String
        vehicleNumber: String
        createdByName: String!
        """
        Set only when the receiving branch raised this as an item request, and kept
        afterwards. Once the source accepts it the state is DRAFT like any other, so
        this is the only thing that still says it was asked for.
        """
        requestedAt: DateTime
        requestedByName: String
        confirmedAt: DateTime
        confirmedByName: String
        dispatchedAt: DateTime
        dispatchedByName: String
        "When the destination accepted the goods, and who accepted them."
        receivedAt: DateTime
        receivedByName: String
        lines: [GoodsTransferLine!]!
        "Full history of this transfer — newest first (take capped at 100)"
        audit(skip: Int, take: Int): TransferAuditList!
        "Damage raised against this transfer by the destination branch"
        damageRequests: [DamageRequest!]!
        """
        Alerts for MY channel newer than alertsAfterId — the same field the list
        carries, so a user sitting on a detail screen is told what happened without
        going back to the list.
        """
        alerts(alertsAfterId: ID): [TransferAlert!]!
    }

    input GoodsTransferLineInput {
        """
        Id of a line already on this transfer. Send it to change that row's QUANTITY;
        leave it out to add a new row. The product on an existing row cannot be
        changed — remove the line and add the new product instead, so nothing already
        pointing at that row starts naming different goods.
        """
        id: ID
        "For pool (weight) products — product-level entry"
        productId: ID
        "For PCS products — variant-level entry"
        productVariantId: ID
        quantityPcs: Int
        """
        The pool quantity in the PRODUCT's own unit — 1.5 for 1.5 kg, 30 for 30 pieces.
        Read that unit off DestinationProduct.poolUnit; it is never sent here, because
        it belongs to the product and is resolved again server-side.

        This is the unit-agnostic way to send a pool line and the only one that works
        for a product which is not weighed. A counted pool refuses a fractional value.
        """
        poolQty: Float
        """
        Weight in kilograms, e.g. 1.5 or 0.05. Stored as integer grams.
        Send this OR weightGrams, never both. Smallest accepted value is 0.001.

        WEIGHED products only. On a counted or volume pool this is refused — send
        poolQty instead.
        """
        weightKg: Float
        """
        Weight in whole grams, for staff reading a gram scale. Send this OR weightKg.
        Weighed products only, same as weightKg.
        """
        weightGrams: Int
    }

    "Start a new transfer. The destination decides which products may be entered."
    input CreateGoodsTransferInput {
        "The receiving branch — any branch except the one you are working in"
        destinationChannelId: ID!
        remarks: String
        driverName: String
        driverPhone: String
        vehicleNumber: String
        "At least one line is required"
        lines: [GoodsTransferLineInput!]!
    }

    """
    Ask a branch to send these items. Raised by the branch that will receive them.

    No driver or vehicle here: those describe a journey the source has not agreed to
    make yet, and it is the source that fills them in when it dispatches.
    """
    input CreateGoodsTransferRequestInput {
        "The branch being asked to send — any branch except the one you are working in"
        sourceChannelId: ID!
        remarks: String
        "At least one line is required"
        lines: [GoodsTransferLineInput!]!
        """
        false keeps the request private until sendGoodsTransferRequest — the branch wants
        to print it and walk the shelves first. Defaults to true, which sends it at once.
        """
        send: Boolean
    }

    """
    Edit an existing transfer. Send ONLY what changes — anything you leave out stays
    exactly as it was.

      lines          -> a row WITH an id has its quantity changed;
                        a row WITHOUT an id is added
      removeLineIds  -> the rows to drop, named explicitly

    Both can be sent in the same call; removals are applied first, so a product can be
    dropped and re-added in one save.

    Nothing is deleted by being absent. Editing one quantity means sending one row, not
    resending the other nine and hoping.

    Allowed at DRAFT, CONFIRMED and DISPATCHED — the vehicle can be stopped to add
    items, or a product that never made it onto it can be dropped. After CONFIRMED the
    document is regenerated and the destination is told exactly what changed. Once
    RECEIVED this is blocked: stock is written, so a change is a damage claim, not an
    edit.

    The destination branch cannot be changed — every line belongs to that branch's
    catalogue. Picked the wrong branch? Delete and start again.
    """
    input UpdateGoodsTransferInput {
        id: ID!
        remarks: String
        driverName: String
        driverPhone: String
        vehicleNumber: String
        lines: [GoodsTransferLineInput!]
        "Lines to drop. All of them cannot be removed — delete the draft instead."
        removeLineIds: [ID!]
    }

    "One damaged product in a request"
    input DamageLineInput {
        "Id of the GoodsTransferLine being reported"
        lineId: ID!
        "PCS product → damagedPcs; pool product → damagedPoolQty (exactly one)"
        damagedPcs: Int
        """
        The damaged amount in the product's own unit — 0.25 for 250 g, 4 for 4 pieces.
        The unit-agnostic input, and the only one that works for a product which is
        not weighed.
        """
        damagedPoolQty: Float
        """
        Damaged weight in kilograms, e.g. 0.25. Send this OR damagedGrams, never both.
        WEIGHED products only — refused on a counted or volume pool.
        """
        damagedKg: Float
        "Damaged weight in whole grams. Send this OR damagedKg. Weighed products only."
        damagedGrams: Int
        "Optional free text for this product"
        note: String
        "Positions in the photos upload list that belong to THIS product. Required when its damage reaches 5%."
        photoIndexes: [Int!]
    }

    input CreateDamageRequestInput {
        transferId: ID!
        remarks: String
        "One entry per damaged product — a whole transfer is reported in a single request"
        lines: [DamageLineInput!]!
    }



    type DestinationProductVariant {
        id: ID!
        sku: String!
        name: String!
        """
        false = not on sale in the destination's app. It can still be put on a transfer
        and printed on the document, but RECEIVING it posts no stock.
        """
        enabled: Boolean!
    }

    "A product assigned to the destination channel — the only products transferable to it"
    type DestinationProduct {
        productId: ID!
        productName: String!
        "true = product-level pool (enter poolQty at product level); false = PCS (enter quantityPcs per variant)"
        isPooled: Boolean!
        """
        What this product's pool is counted in: kg, litre or piece. Null when the
        product is not pooled.

        Derived from the measurement option the merchant attached, exactly as the
        Product Stock block and the order process derive it — a pooled product is NOT
        automatically a weighed one. Label the picker and the quantity box from this,
        and send the quantity as poolQty in this unit.
        """
        poolUnit: String
        """
        false = not on sale in the destination's app. Still selectable here — this
        picker is admin-only — but receiving a disabled line posts no stock.
        Label these in the UI so nobody expects the stock to move.
        """
        enabled: Boolean!
        variants: [DestinationProductVariant!]!
    }

    "What raised an alert."
    enum TransferNotificationType {
        "Another branch asked this one to send items"
        TRANSFER_REQUESTED
        TRANSFER_CONFIRMED
        TRANSFER_UPDATED
        TRANSFER_DISPATCHED
        TRANSFER_DELETED
        TRANSFER_RECEIVED
        DAMAGE_CONFIRMED
        DAMAGE_APPROVED
        DAMAGE_REJECTED
        EXPIRY_SOON
    }

    """
    Something the other branch did that this one should be told about.

    Rides on the list and detail reads the screen already makes — there is no alerts
    query, no polling and no held connection. Show each one as a toast and remember
    the newest id; send it back as alertsAfterId and the same alert never arrives
    twice.

    Deliberately has no read/unread. "Have you seen this" is the client's business;
    the server keeps no per-user state and there is nothing to mark.
    """
    type TransferAlert implements Node {
        id: ID!
        createdAt: DateTime!
        type: TransferNotificationType!
        title: String!
        "Deep-link target: 'transfer' | 'damage' | 'expiry'"
        refType: String!
        "Id within refType — open /transfers/:refId, /damage/:refId, and so on"
        refId: ID!
        "Name of the admin whose action raised this — 'System' for expiry warnings"
        userName: String!
        transferNumber: String
        "Expiry alerts name the product directly"
        productName: String
        "Expiry alerts only — when this stock reaches the end of its shelf life"
        expiresAt: DateTime
    }

    input ReportInput {
        "ISO date; defaults to a year ago"
        from: DateTime
        "ISO date; defaults to now"
        to: DateTime
        "SuperAdmin only — otherwise your selected channel"
        channelIds: [ID!]
        "Matches transfer number, driver name or driver phone"
        search: String
        skip: Int
        take: Int
        """
        Id of the newest alert this client has already shown. Only newer ones come
        back. Omit it and you get the last few minutes — enough for a screen opening
        fresh, not a backlog.

        The marker is the id, not a timestamp: createdAt is stored to microseconds but
        read back to milliseconds, so a timestamp sent back as the marker is still
        earlier than the row it came from, and the same alert repeats forever.
        """
        alertsAfterId: ID
    }

    """
    One product this branch has been warned about — a PRODUCT, not a transfer.

    Expiry belongs to something on a shelf; the transfer is only how it arrived, which
    is why the transfer number is carried along rather than being the subject.

    currentStock is in base units — grams, millilitres or pieces for a pooled product
    (poolUnit says which), pieces otherwise — the same convention as everywhere else
    in this module.
    """
    type ExpiringProduct {
        "The transfer line this came in on. The id an expiry alert points at."
        lineId: ID!
        productName: String!
        sku: String
        "True for pooled products, whose stock is held in base units"
        isPooled: Boolean!
        "What that stock is counted in: kg, litre or piece. Null when not pooled."
        poolUnit: String
        "What the destination holds now. Rows with none left are not returned."
        currentStock: Int!
        receivedAt: DateTime!
        "When the shelf life runs out, as computed when the warning was raised"
        expiresAt: DateTime
        "When the sweep raised the warning"
        warnedAt: DateTime!
        transferId: ID!
        transferNumber: String!
    }

    type ExpiringProductList {
        "Rows with stock remaining — not every warning ever raised"
        totalItems: Int!
        items: [ExpiringProduct!]!
    }

    "Counts for every tab, under the same channel/date/search filters as the rows"
    type TransferReportSummary {
        all: Int!
        "Requests written here and not sent yet"
        requestDraft: Int!
        "Item requests still waiting for the source branch to accept them"
        requested: Int!
        draft: Int!
        confirmed: Int!
        dispatched: Int!
        received: Int!
        damagePending: Int!
        "Approved or rejected — the settled ones"
        damageDecided: Int!
        damageApproved: Int!
        damageRejected: Int!
        """
        Products warned about and still on the shelf — the same rows expiringProducts
        returns, counted. A count of PRODUCTS, unlike every other figure here, which
        counts transfers; expiry is a property of what is on a shelf, not of a
        document.
        """
        expiringSoon: Int!
    }

    "Damage raised against a transfer, summarised for the list"
    type TransferReportDamage {
        id: ID!
        state: DamageState!
        productCount: Int!
        totalDamagedPcs: Int!
        totalDamagedGrams: Int!
        createdAt: DateTime!
        createdByName: String!
        pdfAssetId: ID
    }

    type TransferReportRow {
        id: ID!
        transferNumber: String!
        state: TransferState!
        sourceChannelId: ID!
        destinationChannelId: ID!
        driverName: String
        driverPhone: String
        vehicleNumber: String
        createdByName: String!
        requestedByName: String
        confirmedByName: String
        dispatchedByName: String
        receivedByName: String
        createdAt: DateTime!
        "Set only on rows the receiving branch asked for — survives the move to DRAFT"
        requestedAt: DateTime
        confirmedAt: DateTime
        dispatchedAt: DateTime
        receivedAt: DateTime
        itemCount: Int!
        "Download the transfer document"
        pdfAssetId: ID
        damageRequests: [TransferReportDamage!]!
    }

    type TransferReportResult {
        summary: TransferReportSummary!
        totalItems: Int!
        items: [TransferReportRow!]!
        "What the other branch did, newer than alertsAfterId. Show as toasts; see TransferAlert."
        alerts: [TransferAlert!]!
    }

    extend type Query {
        """
        The list screen, every report tab and the search box in one read.
        Pick the tab with status; summary always carries the count for every tab.
        A destination branch never sees DRAFT.
        """
        goodsTransfers(status: TransferReportStatus, input: ReportInput): TransferReportResult!
        "Detail screen — one transfer with its lines, stock, audit trail and damage requests"
        goodsTransfer(id: ID!): GoodsTransfer!
        """
        Products of the branch chosen in the Ship-To dropdown, matching the search.

        The dropdown is fed by the project's existing getChannelList query — this
        module publishes no channel list of its own. Naming ANOTHER branch you may not
        ship to is refused, exactly as it is on create.

        Naming YOUR OWN branch is allowed and returns your own catalogue: the product
        request screen lists what can arrive here, and the branch asking is the one that
        will receive.

        take defaults to 25 — a picker is typed into, not scrolled. Ask for more when the
        screen really is showing a whole catalogue; the server caps it at 2000.
        """
        searchTransferProducts(
            destinationChannelId: ID!
            search: String
            take: Int
        ): [DestinationProduct!]!
        """
        Products this branch has been warned about, soonest to expire first.

        Product-level on purpose. The EXPIRING_SOON report tab answers "which transfers
        hold something ageing", which makes the reader open each one to find out which
        product was meant — this answers the question actually being asked.

        The window is 80% of the shelf life up to the expiry itself — the span in which
        marking something down can still sell it. A row leaves when its stock is gone or
        when it expires, whichever comes first, so the list never has to be tidied by
        hand.
        """
        expiringProducts(input: ExpiringProductsInput): ExpiringProductList!
        """
        Several of this branch's transfers on ONE sheet — the note a driver carries
        when he is making every drop in one run.

        Creates nothing and stores nothing. Each transfer keeps its own permanent
        document, its own number and its own receipt; this reprints a chosen set of
        them together, built fresh each time, and is the sending branch's paperwork
        alone. A destination signs for one consignment and prints that transfer's own
        document.

        Drafts are never included: a transfer has no document until it is confirmed,
        and a load nobody has confirmed must not reach a driver. The loading list is
        the exception and says why.
        """
        combinedTransferDocument(input: CombinedTransferDocumentInput!): CombinedTransferDocument!
        """
        The same consignments as a FLAT list of lines — what the loading list is built
        from. Same selection as combinedTransferDocument, so the two always cover the
        same transfers.

        Each row carries its LOCAL NAME, which is what decides whether two lines are
        the same product: the branches keep separate catalogues, so one vegetable is a
        different product row with a different id, a different SKU and often a
        different English spelling, and the shopper-facing name is all they share.

        DRAFTS ARE INCLUDED here, unlike the trip note. This is the sheet the godown
        weighs out from, wanted before anything is confirmed — withholding it until
        afterwards would keep it back at exactly the moment it is useful.

        Returned unmerged. Adding the matching quantities together is arithmetic on
        those names, and it belongs with the screen that prints them.
        """
        transferLoadingList(input: CombinedTransferDocumentInput!): TransferLoadingList!
    }

    "Paging for the expiring-products list. No date or search filter: the list is short by nature."
    input ExpiringProductsInput {
        skip: Int
        take: Int
    }

    """
    Which side of a transfer this branch is on.

    OUT is what the branch is SENDING — the driver's run, the godown's picking sheet.
    IN is what is COMING to it: the requests it raised, and anything else on its way.
    """
    enum TransferDirection {
        OUT
        IN
    }

    """
    Which of this branch's consignments to print together.

    Every field is optional, and the defaults are deliberately wide rather than empty
    — the same range the list itself falls back to. The screen sends the dates it is
    showing, so the sheet covers exactly what the person was looking at.
    """
    input CombinedTransferDocumentInput {
        """
        OUT (the default) for transfers this branch is sending; IN for transfers coming
        to it, its own product requests included. The trip note is the sender's paper
        and always reads OUT whatever is sent here.
        """
        direction: TransferDirection
        """
        Exactly which transfers to print, when the caller already knows them — the
        entry screen does, having just created them. Naming any SILENCES the branch
        and date filters below: a window would be a guess that also swept up whatever
        else went to those branches today. Transfers this branch is not on the
        chosen side of are refused whether they are named or not.
        """
        transferIds: [ID!]
        """
        The branches at the far end to include — destinations when OUT, sources when
        IN. Omit it, or send an empty list, for every branch in the window. Ignored
        when transferIds is set.
        """
        branchIds: [ID!]
        from: String
        to: String
    }

    """
    The trip note, handed back as bytes rather than as an asset.

    Not stored, so there is no id to fetch it by later and nothing accumulates in the
    asset store: it is rebuilt whenever it is asked for, from transfers that have not
    changed. The permanent record of any one consignment remains that transfer's own
    document.
    """
    type CombinedTransferDocument {
        "Suggested file name — TRIP-<source>-<branches>-<date>.pdf"
        filename: String!
        "The PDF itself, base64-encoded."
        content: String!
        "The transfers it covers, in the order they are printed."
        transferNumbers: [String!]!
        "The branches it covers, each named once."
        destinationChannelCodes: [String!]!
    }

    "Every line of every consignment in the selection, unmerged and ungrouped."
    type TransferLoadingList {
        "The branch being acted as."
        channelCode: String!
        "Which side of these transfers that branch is on."
        direction: TransferDirection!
        rows: [TransferLoadingListRow!]!
    }

    """
    One line as it was entered, carrying the branch it is going to.

    Quantities keep the module's convention: exactly one of quantityPcs / weightGrams
    is set, and a pool quantity is an integer in its BASE unit with poolUnit saying
    which. Two lines can only ever be added together when they are measured the same
    way — same poolUnit, or both counted.

    The sku is empty for pooled products, which are entered at product level and have
    no variant — so it identifies a line only for counted ones.
    """
    type TransferLoadingListRow {
        "The branch at the far end: where this is going when OUT, where it is from when IN."
        branchCode: String!
        transferNumber: String!
        "The English name, snapshotted onto the line when it was added."
        productName: String!
        """
        Product.customFields.localName for a weighed line, ProductVariant's for a
        counted one — read live, so a name filled in after the transfer was raised
        still counts. Null when nobody has entered one, and those lines cannot be
        matched against another branch.
        """
        localName: String
        sku: String!
        quantityPcs: Int
        "The pool quantity as stored, an integer in the base unit named by poolUnit."
        weightGrams: Int
        "What that figure counts: kg, litre or piece. Null on a counted line."
        poolUnit: String
    }

    extend type Mutation {
        # ---- Building the transfer (source branch) ----
        "Start a new transfer. Issues the transfer number, which never changes afterwards."
        createGoodsTransfer(input: CreateGoodsTransferInput!): GoodsTransfer!
        """
        Ask another branch to send these items — raised by the branch that will RECEIVE
        them, which is the one difference from createGoodsTransfer.

        What comes back is an ordinary transfer sitting one state earlier, at REQUESTED.
        The source branch then edits, confirms and dispatches it through the same calls
        it uses for its own loads, and it arrives through the same receipt. Saving an
        edit or confirming it is the acceptance; there is no separate accept mutation.

        Nothing is reserved. A request is a question, and stock moves only on receipt.
        """
        createGoodsTransferRequest(input: CreateGoodsTransferRequestInput!): GoodsTransfer!
        """
        Send a request that was saved as a draft — the moment it becomes visible to the
        branch being asked, and the moment they are notified.

        Destination-only, and REQUEST_DRAFT only, so a request already sent cannot be
        sent twice and arrive as two.
        """
        sendGoodsTransferRequest(id: ID!): GoodsTransfer!
        """
        Correct a request that has not been sent — the same line semantics as
        updateGoodsTransfer, and the same permission as raising one.

        REQUEST_DRAFT only. A Receiving Manager may raise a request and holds no Update
        permission, so gating the correction on Update left them able to write a draft
        and unable to fix it.
        """
        updateGoodsTransferRequest(input: UpdateGoodsTransferInput!): GoodsTransfer!
        """
        Edit a transfer — allowed at DRAFT, CONFIRMED and DISPATCHED.
        After CONFIRMED this regenerates the document and tells the destination exactly
        what changed. Blocked once RECEIVED.
        """
        updateGoodsTransfer(input: UpdateGoodsTransferInput!): GoodsTransfer!
        """
        Delete the whole entry, permanently. Allowed at DRAFT, CONFIRMED and
        DISPATCHED; refused once RECEIVED, because stock has moved by then and a
        record of where it came from has to survive.

        The transfer number is burned either way and is never reissued. If the
        destination had already been told about this transfer, it is told again that
        it is gone — otherwise it waits for goods that are not coming.
        """
        deleteGoodsTransfer(id: ID!): Boolean!

        # ---- Moving the transfer ----
        "DRAFT → CONFIRMED. Locks the lines, issues the A4 document, notifies the destination."
        confirmGoodsTransfer(id: ID!): GoodsTransfer!
        "CONFIRMED → DISPATCHED. Goods have physically left the source branch."
        dispatchGoodsTransfer(id: ID!): GoodsTransfer!
        """
        DISPATCHED → RECEIVED. The destination accepts the goods and its stock is
        increased. This is the ONLY action in the module that writes stock, and it
        belongs to the destination branch alone.
        """
        receiveGoodsTransfer(id: ID!): GoodsTransfer!

        # ---- Damage (destination branch, RECEIVED transfers only) ----
        """
        Report every damaged product of a transfer in ONE request. Photos are uploaded
        as one flat list; each line claims its own by index. A photo is required for a
        product whose damage reaches 5%. No stock change until approval.
        """
        createDamageRequest(input: CreateDamageRequestInput!, photos: [Upload!]): DamageRequest!
        "PENDING_APPROVAL → APPROVED. Deducts destination stock and issues the damage document."
        approveDamageRequest(id: ID!): DamageRequest!
        "PENDING_APPROVAL → REJECTED. No stock change."
        rejectDamageRequest(id: ID!): DamageRequest!
    }
`;

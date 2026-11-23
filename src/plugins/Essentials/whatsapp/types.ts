export interface WhatsappPluginOptions {
    /** WhatsApp Business phone number ID (from Meta App > WhatsApp > API Setup). */
    phoneNumberId: string;
    /** Permanent system-user access token with whatsapp_business_messaging permission. */
    accessToken: string;
    /** Any string you choose; must match the "Verify token" entered in the Meta webhook settings. */
    verifyToken: string;
    /** Meta App Secret (App settings > Basic). Used to verify the X-Hub-Signature-256 header. */
    appSecret: string;
    /** Storefront URL opened by the "Order now" button. Its origin is also used for login links. */
    storeUrl: string;
    /** Key into WHATSAPP_BRANDS (brands.ts), e.g. "kaaikani". */
    brand: string;
    /** MSG91 account that sends for a brand with sendVia 'msg91'. */
    msg91?: {
        authKey: string;
        /** The WhatsApp number as MSG91 knows it, digits only, e.g. "919840089302". */
        integratedNumber: string;
    };
    /** Graph API version, e.g. "v25.0". */
    graphApiVersion?: string;
    /**
     * Non-empty → the bot answers only these senders (E.164 digits, no "+")
     * and ignores everyone else, so it can be tested on a live number before
     * launch. Empty → it answers everyone.
     */
    testNumbers?: string[];
}

/** Seller block printed on the invoice PDF. */
export interface WhatsappInvoiceSeller {
    name: string;
    headOffice: string;
    /** Storefront layout: joined after "Phone:". Delivery-bill layout: one centred line each, as given. */
    phones: string[];
    /** File name under src/assets. */
    logoFile: string;
    /**
     * 'storefront' (default) → the storefront's order-confirmation invoice.
     * 'delivery-bill' → the bill the delivery dashboard prints, with each
     * item's Tamil/Malayalam name (see DeliveryBillPdfService).
     */
    layout?: 'storefront' | 'delivery-bill';
}

/** One row of the "Choose your city" list. */
export interface WhatsappCity {
    /** Row id Meta echoes back in the list reply; max 200 chars. */
    id: string;
    /** Shown in the list; max 24 chars. */
    title: string;
    /** Channel the customer lands in. Absent → the storefront asks for their pincode. */
    channelCode?: string;
}

/** Everything that differs between the businesses running this plugin. */
export interface WhatsappBrand {
    /** Short name used in message text, e.g. "Star Biriyani". */
    name: string;
    /** What the customer can do on the website; part of the first reply. */
    welcomeLine: string;
    /** Closing line of the welcome and order-placed messages. */
    tagline: string;
    /** Follows "delivered"/"collected", e.g. "Enjoy your meal!". */
    deliveredLine: string;
    /** Number given in cancellation messages and, with a support menu, the "Call us" reply. */
    supportPhone: string;
    /**
     * Present → a separate "Rate us" message follows the delivered message,
     * with a button to this Play Store page. No link can open Google's rating
     * dialog itself; that is only possible from inside the app.
     */
    playStoreUrl?: string;
    /** Present → customers pick a city before getting their login link. At most 10 (Meta's list limit). */
    cities?: WhatsappCity[];
    /** Absent → no invoice PDF is sent. */
    invoiceSeller?: WhatsappInvoiceSeller;
    /**
     * 'msg91' → replies go out through MSG91's API instead of the Cloud API.
     * For a number MSG91 onboarded: Meta refuses sends from any other app
     * (error #200), while receiving through our own app still works.
     */
    sendVia?: 'msg91';
    /**
     * Present → every message gets a "Place new order" / "Support" menu, and
     * "Support" offers "Chat with us" (a chat link to a separate support
     * number) or "Call us" (supportPhone).
     */
    supportMenu?: WhatsappSupportMenu;
    /**
     * Present → orders from any WhatsApp login are messaged, and an update sent
     * more than WHATSAPP_ORDER_WINDOW_MS after the customer's latest WhatsApp
     * login goes out as one of these approved MSG91 templates (Meta refuses
     * free-form messages then). Absent → only orders placed inside that window
     * are messaged, always free-form.
     */
    templates?: WhatsappOrderTemplates;
}

/**
 * Names of approved MSG91 WhatsApp templates (category Utility, language en).
 * Body variables are positional, in the order listed.
 */
export interface WhatsappOrderTemplates {
    /** Header: document (the invoice PDF). Body: name, order code, total (e.g. "1,250.00"). */
    invoice: string;
    /** Body: name, order code, rider name, rider phone. */
    outForDelivery: string;
    /** Body: name, order code. */
    delivered: string;
    /**
     * Sent right after `delivered` for a brand with playStoreUrl. Body: name.
     * Button: a dynamic link `https://play.google.com/{{1}}`, filled at send time.
     */
    rateApp?: string;
}

export interface WhatsappSupportMenu {
    /** The support team's WhatsApp number, E.164 digits without "+". */
    supportNumber: string;
    /** Sent with the "Chat with support" button when the customer taps "Support". */
    supportReply: string;
    /** Typed into the support chat for the customer when the button opens it. */
    supportPrefill: string;
}

/** What the "order placed" confirmation shows the customer. */
export interface WhatsappOrderPlacedMessage {
    /** E.164 digits, no "+" (e.g. "918056305724"). */
    to: string;
    name: string;
    orderCode: string;
    /** Pre-formatted, e.g. "₹1,250.00". */
    total: string;
}

/** The order has left the store with the rider. Delivery orders only. */
export interface WhatsappOrderOutForDeliveryMessage {
    /** E.164 digits, no "+". */
    to: string;
    name: string;
    orderCode: string;
    /** Rider on the order's fulfillment; empty when none is recorded. */
    partnerName: string;
    /** As stored on the fulfillment; formatted for display by the sender. */
    partnerPhone: string;
}

/** The order reached the customer (or was collected, for take-away). */
export interface WhatsappOrderDeliveredMessage {
    /** E.164 digits, no "+". */
    to: string;
    name: string;
    orderCode: string;
    isTakeaway: boolean;
}

/** Asks the customer to rate the app, right after the delivered message. */
export interface WhatsappRateAppMessage {
    /** E.164 digits, no "+". */
    to: string;
    name: string;
    /** The brand's Play Store page. */
    playStoreUrl: string;
}

/** The order was cancelled. */
export interface WhatsappOrderCancelledMessage {
    /** E.164 digits, no "+". */
    to: string;
    name: string;
    orderCode: string;
    /** The customer's own reason, when they asked to cancel; empty otherwise. */
    reason: string;
    paidOnline: boolean;
}

/** Where a take-away customer collects their order. */
export interface WhatsappPickupPointMessage {
    /** E.164 digits, no "+". */
    to: string;
    storeName: string;
    address: string;
    /** Maps link that opens this exact branch. */
    mapUrl: string;
}

/** A contact card inside a `contacts` message. */
export interface WhatsappSharedContact {
    /** "contact_request" when the user shared their own number via our REQUEST_CONTACT_INFO button. */
    origin?: string;
    phones?: Array<{ phone?: string; wa_id?: string; type?: string }>;
}

export interface WhatsappIncomingMessage {
    id: string;
    /**
     * Sender's phone number (E.164 digits, no "+"). Since WhatsApp usernames
     * (2026-06-29) Meta omits it for a username user we have not talked to in
     * 30 days and who is not in our contact book.
     */
    from?: string;
    /** Business-scoped user id (BSUID). Present on every message webhook since April 2026. */
    from_user_id?: string;
    type: string;
    text?: { body: string };
    /** Present when type === 'contacts'. */
    contacts?: WhatsappSharedContact[];
    /** Present when type === 'interactive', e.g. a row picked from our city list. */
    interactive?: {
        type: string;
        list_reply?: { id: string; title?: string };
        button_reply?: { id: string; title?: string };
    };
}

/** The subset of Meta's webhook payload that this plugin reads. */
export interface WhatsappWebhookPayload {
    object?: string;
    entry?: Array<{
        changes?: Array<{
            value?: {
                /** The business number the message was sent to. */
                metadata?: { phone_number_id?: string };
                contacts?: Array<{
                    wa_id?: string;
                    user_id?: string;
                    profile?: { name?: string; username?: string };
                }>;
                messages?: WhatsappIncomingMessage[];
            };
        }>;
    }>;
}

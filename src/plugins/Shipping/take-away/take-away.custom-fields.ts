import { CustomFieldConfig, LanguageCode, StructFieldConfig } from '@vendure/core';

import { validateOrderPickupTime } from './order-pickup-time.validator';
import { validatePickupSlot, validatePickupTime } from './pickup-slot';

/** One end of the pickup window: `h:mm AM` / `h:mm PM` text. */
const pickupTimeField = (name: 'from' | 'to', label: string): StructFieldConfig => ({
    name,
    type: 'string',
    label: [{ languageCode: LanguageCode.en, value: label }],
    description: [{ languageCode: LanguageCode.en, value: 'h:mm AM or h:mm PM, for example 10:00 AM' }],
    validate: (value: unknown) => validatePickupTime(value),
});

/**
 * Store location, editable on the Take Away shipping method's detail page.
 * All public so the storefront can render the map pin straight from
 * `eligibleShippingMethods { customFields }`.
 */
export const takeAwayShippingMethodCustomFields: CustomFieldConfig[] = [
    {
        // The store's daily pickup hours, the same every day. Edited with
        // hour / minute / AM-PM dropdowns inside the Store Location card (its
        // own row is hidden by the bridge). The app offers the customer times
        // within these hours; on order placed they are copied to the order's
        // readonly `pickupSlot` below. Empty means no time is asked for.
        name: 'pickupSlot',
        type: 'struct',
        nullable: true,
        public: true,
        label: [{ languageCode: LanguageCode.en, value: 'Pickup Hours' }],
        description: [
            {
                languageCode: LanguageCode.en,
                value: 'The hours customers may collect Take Away orders, the same every day. The customer chooses a time within them at checkout.',
            },
        ],
        fields: [pickupTimeField('from', 'From'), pickupTimeField('to', 'To')],
        validate: (value: unknown) => validatePickupSlot(value),
        ui: { component: 'take-away-field-bridge' },
    },
    {
        // Optional binding key between this pickup method and its promotion:
        // must equal the promotion's own Coupon code field. On method
        // selection TakeAwayShopResolver auto-applies the code (and removes
        // it on switch), so the promotion applies automatically while this
        // method is selected. Nothing is typed by the customer at checkout.
        name: 'takeAwayCouponCode',
        type: 'string',
        nullable: true,
        public: true,
        label: [{ languageCode: LanguageCode.en, value: 'Take Away Coupon Code (optional)' }],
        description: [
            {
                languageCode: LanguageCode.en,
                value: 'Coupon code of this method’s promotion (e.g. TAKEAWAY10) — must equal the promotion’s Coupon code field. It is applied automatically when the customer selects this method and removed when they switch away. Leave empty for no discount on this method.',
            },
        ],
        ui: { component: 'take-away-field-bridge' },
    },
    {
        name: 'storeAddress',
        type: 'text',
        nullable: true,
        public: true,
        label: [{ languageCode: LanguageCode.en, value: 'Store Address' }],
        description: [{ languageCode: LanguageCode.en, value: 'Full pickup address shown to the customer' }],
        ui: { component: 'take-away-field-bridge' },
    },
    {
        name: 'storeLatitude',
        type: 'float',
        nullable: true,
        public: true,
        label: [{ languageCode: LanguageCode.en, value: 'Store Location Pin' }],
        description: [{ languageCode: LanguageCode.en, value: 'Pin the pickup store on the map' }],
        // Renders the interactive map picker; it writes both this field and
        // storeLongitude (whose default input is suppressed below).
        ui: { component: 'take-away-field-bridge' },
    },
    {
        name: 'storeLongitude',
        type: 'float',
        nullable: true,
        public: true,
        label: [{ languageCode: LanguageCode.en, value: 'Store Longitude' }],
        description: [{ languageCode: LanguageCode.en, value: 'Set via the Store Location Pin map above' }],
        ui: { component: 'take-away-field-bridge' },
    },
    {
        // Comma-separated store phone numbers that get a WhatsApp + SMS alert
        // whenever a take-away order is placed. Private: staff numbers must
        // not leak through the Shop API's eligibleShippingMethods.
        name: 'notificationPhones',
        type: 'string',
        nullable: true,
        public: false,
        label: [{ languageCode: LanguageCode.en, value: 'Order Notification Numbers' }],
        description: [
            {
                languageCode: LanguageCode.en,
                value: 'Comma-separated phone numbers (e.g. 9840012345, 9840067890) that receive a WhatsApp alert (via the Notification WhatsApp Template below) when a customer places a Take Away order with this method.',
            },
        ],
        ui: { component: 'take-away-field-bridge' },
    },
    {
        // Staff alerts are WhatsApp-only and use their own approved template,
        // separate from the customer's confirmation template — the wording of
        // "new order received" vs "your order is confirmed" differs, and MSG91
        // templates are pre-approved with fixed text.
        name: 'notificationWhatsappTemplate',
        type: 'string',
        nullable: true,
        public: false,
        label: [{ languageCode: LanguageCode.en, value: 'Notification WhatsApp Template' }],
        description: [
            {
                languageCode: LanguageCode.en,
                value: 'Approved MSG91 WhatsApp template sent to the Order Notification Numbers when a Take Away order is placed (e.g. new_order_alert). The template body must have exactly two positional variables: {{1}} = order code, {{2}} = order date & time (IST). Staff numbers receive WhatsApp only — no SMS.',
            },
        ],
        ui: { component: 'take-away-field-bridge' },
    },
    {
        name: 'storeMapUrl',
        type: 'string',
        nullable: true,
        public: true,
        label: [{ languageCode: LanguageCode.en, value: 'Store Map Link' }],
        description: [
            { languageCode: LanguageCode.en, value: 'Google Maps share link for the pickup store (optional)' },
        ],
        // Hidden in the admin form (storefronts can build a maps URL from
        // lat/lng); still settable via the Admin API if ever needed.
        ui: { component: 'take-away-field-bridge' },
    },
];

/**
 * Snapshot of the pickup location taken when the order is placed. Readonly —
 * written only by TakeAwayOrderSnapshotService — so old orders keep showing
 * the store location as it was at purchase time. Their form rows are hidden
 * on the order page (suppressed inputs, no tab): admins see the pickup info
 * as the map card rendered by the order-location-map plugin instead.
 */
export const takeAwayOrderCustomFields: CustomFieldConfig[] = [
    {
        // The time the customer chose, written through the core
        // `setOrderCustomFields` mutation, so NOT readonly. Validated against
        // the selected pickup method's hours; required at checkout by
        // takeAwayPickupTimeProcess whenever the method has hours. Its form
        // row is hidden on the admin order page: the dashboard shows it in
        // the order table's Shipping row and the Angular admin in the
        // Pickup store card.
        name: 'pickupTime',
        type: 'string',
        nullable: true,
        public: true,
        label: [{ languageCode: LanguageCode.en, value: 'Pickup Time' }],
        description: [
            { languageCode: LanguageCode.en, value: 'Time the customer chose to collect this Take Away order, e.g. 10:30 AM' },
        ],
        validate: (value, injector, ctx) => validateOrderPickupTime(value, injector, ctx),
        ui: { component: 'take-away-suppressed-input' },
    },
    {
        // Snapshot of the method's pickup hours at order placement, written
        // by TakeAwayOrderSnapshotService like the fields below. Shown on the
        // admin order page's pickup card next to the chosen time.
        name: 'pickupSlot',
        type: 'struct',
        nullable: true,
        public: true,
        readonly: true,
        label: [{ languageCode: LanguageCode.en, value: 'Pickup Hours' }],
        fields: [pickupTimeField('from', 'From'), pickupTimeField('to', 'To')],
        ui: { component: 'take-away-suppressed-input' },
    },
    {
        name: 'isTakeAway',
        type: 'boolean',
        defaultValue: false,
        public: true,
        readonly: true,
        label: [{ languageCode: LanguageCode.en, value: 'Take Away Order' }],
        ui: { component: 'take-away-suppressed-input' },
    },
    {
        name: 'pickupAddress',
        type: 'text',
        nullable: true,
        public: true,
        readonly: true,
        label: [{ languageCode: LanguageCode.en, value: 'Pickup Address' }],
        ui: { component: 'take-away-suppressed-input' },
    },
    {
        name: 'pickupLatitude',
        type: 'float',
        nullable: true,
        public: true,
        readonly: true,
        label: [{ languageCode: LanguageCode.en, value: 'Pickup Latitude' }],
        ui: { component: 'take-away-suppressed-input' },
    },
    {
        name: 'pickupLongitude',
        type: 'float',
        nullable: true,
        public: true,
        readonly: true,
        label: [{ languageCode: LanguageCode.en, value: 'Pickup Longitude' }],
        ui: { component: 'take-away-suppressed-input' },
    },
    {
        name: 'pickupMapUrl',
        type: 'string',
        nullable: true,
        public: true,
        readonly: true,
        label: [{ languageCode: LanguageCode.en, value: 'Pickup Map Link' }],
        ui: { component: 'take-away-suppressed-input' },
    },
];

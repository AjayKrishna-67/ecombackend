import { LanguageCode, VendureConfig } from '@vendure/core';

import { STOCK_UNITS, STOCK_UNIT_CODES } from './plugins/Stock/shared/stock-units';

/**
 * Unit dropdown, derived from the STOCK_UNITS table rather than retyped. The
 * table already owns the code, the label and the base-unit conversion, so a
 * new unit is added in exactly one place and the picker follows.
 */
const stockUnitOptions = STOCK_UNIT_CODES.map(code => ({
  value: code,
  label: [{ languageCode: LanguageCode.en, value: STOCK_UNITS[code].label }],
}));

export const customFields: VendureConfig['customFields'] = {
  Order: [
    {
      name: 'platform',
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Platform' }],
      description: [{ languageCode: LanguageCode.en, value: 'Source platform (e.g., Kaaikani, Southmithat)' }],
      nullable: true,
      public: true,
    },
    {
      name: 'deviceMedium',
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Device Medium' }],
      description: [{ languageCode: LanguageCode.en, value: 'Device type (e.g., Android, iOS, Website, App)' }],
      nullable: true,
      public: true,
    },
    {
      name: 'razorpayOrderId',
      type: 'string',
      public: false,
      ui: {
        tab: 'Payment',
        width: 'half'
      },
    },
    {
      name: 'razorpayPaymentId',
      type: 'string',
      public: false,
      readonly: true,
      ui: {
        tab: 'Payment',
        width: 'half'
      }
    },
    {
      name: 'isPaymentWindowOpen',
      type: 'boolean',
      defaultValue: false,
      public: false,
      label: [{ languageCode: LanguageCode.en, value: 'Payment Status' }],
      ui: {
        tab: 'Payment',
        component: 'payment-window-status',
        width: 'half'
      }
    },
    {
      name: 'invoiceNo',
      type: 'string',
      nullable: true,
      // Database-level guarantee that no two orders can hold the same invoice
      // number. Application logic alone has failed at this before (a sequence
      // row edited by hand below the highest issued number reissues numbers
      // deterministically). MySQL permits many NULLs in a unique index, so
      // unnumbered orders are unaffected. InvoiceNumberService catches the
      // rejection, heals the sequence and retries.
      unique: true,
      public: true,
      label: [{ languageCode: LanguageCode.en, value: 'Invoice No' }],
      description: [{ languageCode: LanguageCode.en, value: 'Auto-generated invoice number (e.g. M-1, S-42). Prefix set per channel.' }],
    }
  ],
  Product: [
    {
      name: 'hsnCode',
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'HSN CODE' }],
    },
    {
      // Nutrition facts for the product page. Optional, typed into a plain
      // input box (like HSN CODE above), one fact after another separated by
      // commas, e.g. "Energy: 43 kcal, Protein: 1.6 g, Fibre: 2.8 g". The
      // storefront splits on the separators and lays the facts out itself,
      // so no editor or markup is needed here. `length` lifts the default
      // 255-character cap. One value for every language: nutrition numbers
      // do not need translating, and a plain field is always returned,
      // whereas a locale field would come back null for a language it was
      // never entered in. Storefronts show it only when set.
      name: 'nutritions',
      type: 'string',
      length: 1000,
      nullable: true,
      public: true,
      label: [{ languageCode: LanguageCode.en, value: 'Nutritions' }],
      description: [{ languageCode: LanguageCode.en, value: 'Optional. Nutrition facts shown on the product page, e.g. "Energy: 43 kcal, Protein: 1.6 g, Fibre: 2.8 g".' }],
    },
    {
      // Customer-facing name in the shopper's own language. Deliberately NOT a
      // translation of `product.name`: that name is load-bearing in English
      // across the purchase-list PDF, invoices and the delivery dashboard, all
      // of which are operated in English. This field carries the display name
      // and leaves those surfaces untouched.
      //
      // `localeString` stores ONE value PER LANGUAGE on product_translation, so
      // Tamil, Malayalam and any future language share this single declaration.
      // Which language a typed value lands in is decided by the content-language
      // switcher in the Dashboard, so a channel must list the language in its
      // availableLanguageCodes before anything can be entered for it.
      //
      // Empty values do NOT fall back to `name` -- the API returns null, and the
      // storefront must do `localName ?? name` itself.
      name: 'localName',
      type: 'localeString',
      nullable: true,
      public: true,
      label: [{ languageCode: LanguageCode.en, value: 'Local Name' }],
      description: [{ languageCode: LanguageCode.en, value: 'Shopper-facing name in the selected content language.' }],
    },
    {
      name: 'productStockEnabled',
      type: 'boolean',
      defaultValue: false,
      nullable: true,
      public: false,
      // Deliberately blank, not omitted. The dashboard renders the label
      // unconditionally (custom-fields-form.tsx:387) with
      // `getTranslation(label) ?? fieldName`, and `??` does not catch an empty
      // string -- so a blank value renders nothing, whereas omitting `label`
      // falls back to printing "productStockEnabled".
      //
      // The real labelled control lives in the Product Stock block directly
      // below, which binds to this same form field. Everything this entry would
      // render is therefore duplication: no label, no description, and a no-op
      // input component.
      //
      // Not `internal: true` -- that would drop the field from the Admin API,
      // and the block reads it via form.watch('customFields.productStockEnabled').
      label: [{ languageCode: LanguageCode.en, value: '' }],
      ui: { component: 'product-stock-toggle-suppressed' },
    },
  ],
  FacetValue: [
    {
      // Purchase-list section order. The buying team reads the sheet in a fixed
      // sequence -- vegetables, then fruits, then greens -- and this is where
      // that sequence is authored. Replaces the `OrdNo` column of the
      // hand-maintained spreadsheet.
      //
      // It lives on the FACET VALUE rather than in a code-side map for two
      // reasons. First, it can be changed by an admin without a deploy. Second,
      // and more importantly, this catalogue has the same category spelled
      // several ways -- "Vegetables" exists as facet values 2, 86 and 107 across
      // the `category`, `vegetables` and `vegetables-3` facets, and "Fruits" as
      // 1, 25 and 106. A single number per VALUE lets all of them be tagged 1
      // and collapse into one section, which a name-based grouping cannot do.
      //
      // A product usually carries several tagged values (Vegetables AND Ready to
      // Eat). The LOWEST number wins -- see resolveOrdNo in the purchase-list
      // service. Leave blank for anything that is not a purchase-list section;
      // those products sort last.
      name: 'purchaseOrdNo',
      type: 'int',
      nullable: true,
      public: false,
      label: [{ languageCode: LanguageCode.en, value: 'Purchase list order' }],
      description: [
        {
          languageCode: LanguageCode.en,
          value: 'Section number on the Purchase List (1 = vegetables, 2 = fruits, ...). Give every spelling of the same category the SAME number so they merge into one section. Blank means the product is not sectioned and sorts last.',
        },
      ],
      ui: { component: 'number-form-input', options: { min: 1, step: 1 } },
    },
  ],
  ProductOption: [
    {
      // The ONLY source of a variant's weight/unit (the old variant `weight`
      // and `stockUnit` fields were removed). Authored once on the shared
      // option ("1 KG" = 1, 'kg') and inherited by every product using the
      // group -- Vendure 3.6 made ProductOptionGroup shared and ChannelAware,
      // which is what makes this worth doing.
      name: 'measureValue',
      type: 'float',
      nullable: true,
      public: true,
      label: [{ languageCode: LanguageCode.en, value: 'Measure Value' }],
      description: [
        {
          languageCode: LanguageCode.en,
          value: 'Amount one unit of this option contains, in the unit below. Example: for "1/2 KG" enter 0.5 and pick Kilograms.',
        },
      ],
      ui: { width: 'half' },
    },
    {
      name: 'measureUnit',
      type: 'string',
      nullable: true,
      public: true,
      label: [{ languageCode: LanguageCode.en, value: 'Measure Unit' }],
      description: [
        {
          languageCode: LanguageCode.en,
          value: 'Unit for the value above. Weight units (g/kg) drive shipping and weight-pool stock; volume and counted units do not.',
        },
      ],
      options: stockUnitOptions,
      ui: { width: 'half' },
    },
  ],
  ProductVariant: [
    {
      name: 'shadowPrice',
      type: 'int',
      nullable: true,
      label: [{ languageCode: LanguageCode.en, value: 'Shadow Price' }],
    },
    {
      // Variant counterpart of Product.localName -- see the note there. Needed
      // separately because a variant name carries the distinguishing part
      // ("500 g", "Bundle of 6") that shoppers read alongside the product name.
      name: 'localName',
      type: 'localeString',
      nullable: true,
      public: true,
      label: [{ languageCode: LanguageCode.en, value: 'Local Name' }],
      description: [{ languageCode: LanguageCode.en, value: 'Shopper-facing variant name in the selected content language.' }],
    },
    {
      name: 'maxOrderQuantity',
      type: 'int',
      nullable: true,
      public: true,
      label: [{ languageCode: LanguageCode.en, value: 'Max Customer Quantity' }],
      description: [{ languageCode: LanguageCode.en, value: 'Maximum quantity a customer can purchase (across all orders since the start date). Guests must login.' }],
    },
    {
      name: 'maxQuantityStartDate',
      type: 'datetime',
      nullable: true,
      public: true,
      label: [{ languageCode: LanguageCode.en, value: 'Limit Start Date' }],
      description: [{ languageCode: LanguageCode.en, value: 'Only orders placed after this date count toward the limit. Update this to reset limits for a new promotion.' }],
    },
  ],
  Address: [
    {
      name: 'latitude',
      type: 'float',
      nullable: true,
      public: true,
      label: [{ languageCode: LanguageCode.en, value: 'Latitude' }],
      description: [{ languageCode: LanguageCode.en, value: 'Map pin latitude set by the customer' }],
    },
    {
      name: 'longitude',
      type: 'float',
      nullable: true,
      public: true,
      label: [{ languageCode: LanguageCode.en, value: 'Longitude' }],
      description: [{ languageCode: LanguageCode.en, value: 'Map pin longitude set by the customer' }],
    },
  ],
  Customer: [
    {
      name: 'location',
      type: 'string',
      description: [{ languageCode: LanguageCode.en, value: 'Current Location' }],
    },
    {
      name: 'lastSeenAt',
      type: 'datetime',
      nullable: true,
      public: false,
      label: [{ languageCode: LanguageCode.en, value: 'Last Seen At' }],
      description: [{ languageCode: LanguageCode.en, value: 'Timestamp of last heartbeat from the customer' }],
      ui: { tab: 'Activity' },
    },
    {
      name: 'activePlatform',
      type: 'string',
      nullable: true,
      public: false,
      label: [{ languageCode: LanguageCode.en, value: 'Active Platform' }],
      description: [{ languageCode: LanguageCode.en, value: 'Platform the customer is currently active on (Web, App, PWA)' }],
      ui: { tab: 'Activity' },
    },
  ],
  Channel: [
    {
      name: 'type',
      type: 'string',
      // Free-text (no `options`) by request — renders a text input, not a dropdown.
      // WARNING: code branches on exact values 'CITY' | 'BRAND' | 'DIRECT' in ~16
      // sites (channel-availability switcher + delivery availability + customer-channel).
      // Typing any other value silently drops that channel from the switcher and
      // availability. Keep values EXACTLY 'CITY'/'BRAND'/'DIRECT' for logic to work.
      nullable: true,
      label: [{ languageCode: LanguageCode.en, value: 'Channel Type' }],
      description: [{ languageCode: LanguageCode.en, value: 'Use CITY, BRAND or DIRECT. Other values disable brand-switcher/availability logic for this channel.' }],
      ui: { tab: 'Details' },
    },
    {
      name: 'enabled',
      type: 'boolean',
      label: [{ languageCode: LanguageCode.en, value: 'Channel Enabled' }],
      description: [{ languageCode: LanguageCode.en, value: 'Enable or disable this channel for customer access' }],
      defaultValue: true,
      public: true,
      ui: { tab: 'Details' },
    },
    {
      name: 'invoicePrefix',
      type: 'string',
      nullable: true,
      label: [{ languageCode: LanguageCode.en, value: 'Invoice Prefix' }],
      // The prefix IS the sequence group: every channel sharing a non-empty
      // prefix shares ONE running invoice sequence (e.g. Coimbatore and
      // Coimbatore zone 2 both "C-" → C-1660, C-1661, ... across both).
      // Give a channel its own prefix to give it its own sequence.
      description: [{ languageCode: LanguageCode.en, value: 'Prefix for invoice numbers. E.g. "M-" for Madurai → M-1, M-2. Channels sharing the same prefix share ONE continuous invoice sequence. Leave empty to use plain numbers on an independent sequence.' }],
      ui: { tab: 'Invoice' },
    },
    {
      // Stored in paise like every Vendure money value; the currency input
      // lets the admin type rupees. 0 (or empty) = no minimum.
      name: 'minimumOrderAmount',
      type: 'int',
      nullable: true,
      defaultValue: 0,
      min: 0,
      label: [{ languageCode: LanguageCode.en, value: 'Minimum Order Value' }],
      description: [{ languageCode: LanguageCode.en, value: "Customers of this channel cannot check out until the cart's product total (after discounts, before delivery charges) reaches this amount. 0 = no minimum." }],
      ui: { component: 'currency-form-input', tab: 'Checkout' },
    },
  ],
  ShippingMethod: [
    {
      name: 'enabled',
      type: 'boolean',
      label: [{ languageCode: LanguageCode.en, value: 'Shipping Method Enabled' }],
      description: [{ languageCode: LanguageCode.en, value: 'Enable or disable this shipping method for orders' }],
      defaultValue: true,
      public: true,
      ui: {
        tab: 'Visibility',
        component: 'app-shipping-method-toggle',
      },
    },
  ],
  Administrator: [
    {
      name: 'phoneNumber', type: 'string', public: true,
      label: [{ languageCode: LanguageCode.en, value: 'Phone Number' }],
    },
  ],
};

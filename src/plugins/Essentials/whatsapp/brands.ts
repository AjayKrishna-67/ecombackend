import { WhatsappBrand } from './types';

/**
 * Wording and seller details for each business that runs this plugin on its
 * own server and WhatsApp number. The server picks one with WA_BRAND.
 */
export const WHATSAPP_BRANDS: Readonly<Record<string, WhatsappBrand>> = {
    'star-biryani': {
        name: 'Star Biriyani',
        welcomeLine: 'Browse our menu and place your order on our website.',
        tagline: 'Fresh biriyani, delivered hot.',
        deliveredLine: 'Enjoy your meal!',
        supportPhone: '+91 4174 247373',
        /**
         * Mirrors BRAND in the storefront (Remix_Storefront app/constants.ts),
         * which prints the same invoice on the order-confirmation page — keep
         * the two in step.
         */
        invoiceSeller: {
            name: 'Ambur Star Briyani',
            headOffice: '#5, National Highway, Kannikapuram, Ambur - 635802',
            phones: ['+91 4174 247373', '+91 98942 47373'],
            /** Copy of the storefront's public/brand/logo-512.png. */
            logoFile: 'star-briyani-logo.png',
        },
    },
    kaaikani: {
        name: 'Kaaikani',
        welcomeLine: 'Shop fresh vegetables and fruits on our website.',
        tagline: 'Fresh to your doorstep — Ungal Veeduvarai.',
        deliveredLine: 'Enjoy your fresh produce!',
        // Toll-free customer care: given in cancellation messages and the "Call us" support option.
        supportPhone: '1800 309 4983',
        // Opened by the "Rate us" button of the message that follows "delivered".
        playStoreUrl: 'https://play.google.com/store/apps/details?id=com.kaaikani.kaaikani&showAllReviews=true',
        // Coimbatore has no channelCode: it is split into zones (Coimbatore,
        // Coimbatore Zone 2) that only the customer's pincode can tell apart,
        // so the storefront asks for it.
        cities: [
            { id: 'coimbatore', title: 'Coimbatore' },
            // Customers know this store by its town, Thodupuzha; the channel stays Idukki.
            { id: 'idukki', title: 'Thodupuzha', channelCode: 'Idukki' },
            { id: 'madurai', title: 'Madurai', channelCode: 'Madurai' },
            { id: 'salem', title: 'Salem', channelCode: 'Salem' },
            { id: 'trichy', title: 'Trichy', channelCode: 'Trichy' },
        ],
        // 98400 89302 was onboarded by MSG91, so only MSG91 can send from it.
        sendVia: 'msg91',
        // Support lives on its own number (MSG91 Hello); this one is the order bot.
        supportMenu: {
            supportNumber: '919894681385',
            supportReply: 'For help with an order or anything else, chat with our support team on WhatsApp: +91 98946 81385',
            supportPrefill: 'Hi, I need help with my order',
        },
        /**
         * Mirrors the header of the bill the delivery dashboard prints
         * (Delivery-PWA app/reports/page.tsx buildBillHtml) — keep the two in step.
         */
        invoiceSeller: {
            name: 'Kaaikani',
            headOffice: 'Kovil Papakudi, Madurai-625018',
            phones: ['Toll Free: 1800 309 4983'],
            /** Same PDF-sized logo the goods-transfer documents use. */
            logoFile: 'KaaiKani-pdf.png',
            layout: 'delivery-bill',
        },
        // Created in MSG91 on 919840089302 (category Utility).
        templates: {
            invoice: 'kk_order_invoice',
            outForDelivery: 'kk_order_out_for_delivery',
            delivered: 'kk_order_delivered',
            rateApp: 'kk_rate_app',
        },
    },
};

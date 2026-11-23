import { Inject, Injectable } from '@nestjs/common';
import { Logger } from '@vendure/core';
import { createHmac, timingSafeEqual } from 'crypto';

import {
    DEFAULT_GRAPH_API_VERSION,
    IGNORED_MESSAGE_TYPES,
    LOGIN_PATH,
    loggerCtx,
    MENU_ORDER_ID,
    MENU_SUPPORT_ID,
    SUPPORT_CALL_ID,
    SUPPORT_CHAT_ID,
    ORDERS_PATH,
    WHATSAPP_PLUGIN_OPTIONS,
} from '../constants';
import { WHATSAPP_BRANDS } from '../brands';
import { cleanProfileName, sharedOwnPhone, toIndianMobile } from '../functions/customer-identity';
import {
    WhatsappBrand,
    WhatsappCity,
    WhatsappIncomingMessage,
    WhatsappOrderCancelledMessage,
    WhatsappOrderDeliveredMessage,
    WhatsappOrderOutForDeliveryMessage,
    WhatsappOrderPlacedMessage,
    WhatsappPickupPointMessage,
    WhatsappPluginOptions,
    WhatsappRateAppMessage,
    WhatsappSupportMenu,
    WhatsappWebhookPayload,
} from '../types';
import { VerifiedWhatsappLogin, WhatsappLoginService } from './whatsapp-login.service';

const MAX_SEEN_IDS = 1000;
const MSG91_SEND_URL = 'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/';
// Meta's Graph API has no documented SLA on response time; a hung connection must
// not stall handleIncoming's sequential per-message loop indefinitely.
const SEND_TIMEOUT_MS = 10_000;

interface WelcomeCard {
    to: string;
    name: string;
    url: string;
    isLoginLink: boolean;
    /** The city the customer picked from our list, if the brand has one. */
    city?: WhatsappCity;
}

@Injectable()
export class WhatsappService {
    // Meta retries a webhook if it doesn't get a 200 quickly, so the same message id
    // can arrive more than once. Remember recent ids to avoid double replies.
    // In-memory only: fine for a single server instance.
    private readonly seenMessageIds = new Set<string>();

    constructor(
        @Inject(WHATSAPP_PLUGIN_OPTIONS) private readonly options: WhatsappPluginOptions,
        private readonly loginService: WhatsappLoginService,
    ) {}

    /** This server's business (WA_BRAND). Throws if WA_BRAND names no brand. */
    get brand(): WhatsappBrand {
        const brand = WHATSAPP_BRANDS[this.options.brand];
        if (!brand) {
            throw new Error(`Unknown WhatsApp brand "${this.options.brand}"; set WA_BRAND`);
        }
        return brand;
    }

    /** Full business name (the invoice's seller), falling back to the short name. */
    get sellerName(): string {
        return this.brand.invoiceSeller?.name ?? this.brand.name;
    }

    /** True only when `token` is non-empty and matches the configured webhook verify token. */
    isValidVerifyToken(token: string | undefined): boolean {
        return !!token && token === this.options.verifyToken;
    }

    /**
     * Meta signs every webhook POST with HMAC-SHA256(rawBody, appSecret).
     * Without this check anyone who finds the URL could make us send messages.
     * An empty appSecret must fail closed: HMAC with an empty key is still a
     * digest anyone can compute, so a misconfigured (empty) secret is treated
     * the same as no secret at all, not as an automatic pass.
     */
    isValidSignature(rawBody: Buffer | undefined, signatureHeader: string | undefined): boolean {
        if (!this.options.appSecret || !rawBody || !signatureHeader?.startsWith('sha256=')) {
            return false;
        }
        const expected = createHmac('sha256', this.options.appSecret).update(rawBody).digest();
        const received = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');
        return received.length === expected.length && timingSafeEqual(received, expected);
    }

    /**
     * Entry point for every webhook delivery. Flattens Meta's nested
     * entry[]/changes[]/messages[] structure via collectMessages, then replies
     * to each message in turn. One message's failure (a downed DB, a failed
     * Graph API call) is logged and must not stop the rest of the batch from
     * being answered.
     */
    async handleIncoming(payload: WhatsappWebhookPayload): Promise<void> {
        for (const { message, profileName } of this.collectMessages(payload)) {
            if (!this.markSeen(message.id)) {
                continue;
            }
            if (IGNORED_MESSAGE_TYPES.includes(message.type)) {
                continue;
            }
            if (!this.isTester(message)) {
                continue;
            }
            Logger.info(
                `Message ${message.id} from ${message.from ?? message.from_user_id} (type ${message.type})`,
                loggerCtx,
            );
            try {
                await this.replyTo(message, profileName);
            } catch (err) {
                Logger.error(
                    `Reply to message ${message.id} failed: ${err instanceof Error ? err.message : String(err)}`,
                    loggerCtx,
                );
            }
        }
    }

    /** True when no tester list is set, or the sender is on it. Real customers are not logged. */
    private isTester(message: WhatsappIncomingMessage): boolean {
        const testers = this.options.testNumbers ?? [];
        if (testers.length === 0) {
            return true;
        }
        const sender = message.from ?? sharedOwnPhone(message);
        return !!sender && testers.includes(sender);
    }

    /**
     * Flattens entry[].changes[].value.messages[] into one list, resolving each
     * message's contact (and therefore its WhatsApp profile name) by matching on
     * wa_id (phone senders) or user_id (BSUID/username senders).
     */
    private collectMessages(
        payload: WhatsappWebhookPayload,
    ): Array<{ message: WhatsappIncomingMessage; profileName: string | undefined }> {
        const result: Array<{ message: WhatsappIncomingMessage; profileName: string | undefined }> = [];
        for (const entry of payload.entry ?? []) {
            for (const change of entry.changes ?? []) {
                const value = change.value;
                // The app may be subscribed to more than one number (e.g. Meta's
                // test number and the live one). Answer only our own: a reply
                // would otherwise come from a different number than the customer
                // wrote to, with links to whichever store this server serves.
                const toPhoneId = value?.metadata?.phone_number_id;
                if (toPhoneId && toPhoneId !== this.options.phoneNumberId) {
                    continue;
                }
                // Status updates (sent/delivered/read) have no `messages` array.
                for (const message of value?.messages ?? []) {
                    const contact = value?.contacts?.find(
                        c =>
                            (!!message.from && c.wa_id === message.from) ||
                            (!!message.from_user_id && c.user_id === message.from_user_id),
                    );
                    result.push({ message, profileName: contact?.profile?.name });
                }
            }
        }
        return result;
    }

    /**
     * Indian phone → one-tap login link. Other phone → plain store link.
     * No phone at all (WhatsApp username user) → ask them to share it; the
     * resulting `contacts` message comes back through here with the phone.
     * A brand with cities asks for the city first, every time: any message
     * gets the city list, and only a tap on one of its rows gets the link.
     * A brand with a support menu answers every message with it; "Support"
     * offers chat or call (see WhatsappBrand.supportMenu).
     */
    private async replyTo(message: WhatsappIncomingMessage, profileName: string | undefined): Promise<void> {
        const menu = this.brand.supportMenu;
        const phone = message.from ?? sharedOwnPhone(message);
        if (!phone) {
            if (message.from_user_id) {
                await this.sendPhoneRequest(message.from_user_id);
            }
            return;
        }
        const name = cleanProfileName(profileName);
        if (menu) {
            const choice = message.interactive?.button_reply?.id;
            if (choice === MENU_SUPPORT_ID) {
                await this.sendSupportOptions(phone);
                return;
            }
            if (choice === SUPPORT_CHAT_ID) {
                await this.sendSupportLink(phone, menu);
                return;
            }
            if (choice === SUPPORT_CALL_ID) {
                await this.sendCallUs(phone);
                return;
            }
            // Any other message gets the menu. "Place new order" and city
            // taps carry on to the order flow below.
            if (choice !== MENU_ORDER_ID && !message.interactive?.list_reply) {
                await this.sendMenu(phone, name);
                return;
            }
        }
        await this.startOrder(message, phone, name);
    }

    /** Store link (non-Indian number), city list, or the one-tap login link. */
    private async startOrder(message: WhatsappIncomingMessage, phone: string, name: string): Promise<void> {
        const mobile = toIndianMobile(phone);
        if (!mobile) {
            await this.sendWelcome({ to: phone, name, url: this.options.storeUrl, isLoginLink: false });
            return;
        }
        const cities = this.brand.cities;
        if (!cities?.length) {
            const url = await this.buildLoginUrl({ phoneNumber: mobile, firstName: name });
            await this.sendWelcome({ to: phone, name, url, isLoginLink: true });
            return;
        }
        const pickedId = message.interactive?.list_reply?.id;
        const city = cities.find(c => c.id === pickedId);
        if (!city) {
            await this.sendCityList(phone, name, cities);
            return;
        }
        const url = await this.buildLoginUrl({ phoneNumber: mobile, firstName: name }, city);
        await this.sendWelcome({ to: phone, name, url, isLoginLink: true, city });
    }

    /**
     * Opens the picked city's channel on the storefront. A city without a
     * channel (one split into zones), or whose channel is missing, carries no
     * channel token, and the storefront asks for the customer's pincode.
     */
    private async cityParams(city: WhatsappCity): Promise<Record<string, string>> {
        if (!city.channelCode) {
            return { city: city.title };
        }
        const channel = await this.loginService.findChannelToken(city.channelCode);
        if (!channel) {
            Logger.error(
                `City "${city.title}": no channel with code "${city.channelCode}"; storefront will ask for the pincode`,
                loggerCtx,
            );
            return { city: city.title };
        }
        return { city: city.title, channel };
    }

    /**
     * The secret goes in the URL fragment (#token=…), not the query string: browsers
     * never send a fragment to any server or in a Referer header, so it stays out of
     * storefront/proxy access logs. Only the page's own script can read it.
     */
    private async buildLoginUrl(login: VerifiedWhatsappLogin, city?: WhatsappCity): Promise<string> {
        const secret = await this.loginService.issueVerified(login);
        const url = new URL(LOGIN_PATH, this.options.storeUrl);
        const cityParams = city ? await this.cityParams(city) : {};
        url.hash = new URLSearchParams({ token: secret, ...cityParams }).toString();
        return url.toString();
    }

    /** "Place new order" / "Support" reply buttons; the tapped one comes back as a button_reply. */
    private async sendMenu(to: string, name: string): Promise<void> {
        const { brand } = this;
        await this.sendMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: {
                    // max 1024 chars
                    text: `Hi ${name || 'there'},\n\nWelcome to ${brand.name}! How can we help you today?`,
                },
                footer: { text: brand.tagline }, // max 60 chars
                action: {
                    buttons: [
                        // title max 20 chars
                        { type: 'reply', reply: { id: MENU_ORDER_ID, title: '🛒 Place new order' } },
                        { type: 'reply', reply: { id: MENU_SUPPORT_ID, title: '💬 Support' } },
                    ],
                },
            },
        });
    }

    /** "Chat with us" / "Call us" reply buttons; the tapped one comes back as a button_reply. */
    private async sendSupportOptions(to: string): Promise<void> {
        await this.sendMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: { text: 'How would you like to reach us?' }, // max 1024 chars
                action: {
                    buttons: [
                        // title max 20 chars
                        { type: 'reply', reply: { id: SUPPORT_CHAT_ID, title: '💬 Chat with us' } },
                        { type: 'reply', reply: { id: SUPPORT_CALL_ID, title: '📞 Call us' } },
                    ],
                },
            },
        });
    }

    /**
     * The customer-care number as text. A session message cannot carry a call
     * button (cta_url takes https only; call buttons exist only in approved
     * templates), but WhatsApp makes a phone number in the text tappable.
     */
    private async sendCallUs(to: string): Promise<void> {
        await this.sendMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: {
                preview_url: false,
                // max 4096 chars
                body: `Call our customer care (toll-free): ${this.brand.supportPhone}`,
            },
        });
    }

    /** "Chat with support" button opening a WhatsApp chat with the support number, message pre-typed. */
    private async sendSupportLink(to: string, menu: WhatsappSupportMenu): Promise<void> {
        // %20, not URLSearchParams' "+": WhatsApp shows a "+" literally in the typed message.
        const url = `https://wa.me/${menu.supportNumber}?text=${encodeURIComponent(menu.supportPrefill)}`;
        await this.sendMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'cta_url',
                body: { text: menu.supportReply }, // max 1024 chars
                action: {
                    name: 'cta_url',
                    parameters: {
                        display_text: 'Chat with support', // max 20 chars
                        url,
                    },
                },
            },
        });
    }

    /** Interactive list of the brand's cities; the tapped row comes back as a list_reply. */
    private async sendCityList(to: string, name: string, cities: WhatsappCity[]): Promise<void> {
        const { brand } = this;
        await this.sendMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'list',
                header: { type: 'text', text: `Welcome to ${brand.name}` }, // max 60 chars
                body: {
                    // max 1024 chars
                    text:
                        `Hi ${name || 'there'},\n\n` +
                        `Thanks for reaching out! ${brand.welcomeLine}\n\n` +
                        `Choose your city to get started.`,
                },
                footer: { text: brand.tagline }, // max 60 chars
                action: {
                    button: 'Choose city', // max 20 chars
                    sections: [
                        {
                            title: 'Cities', // max 24 chars
                            rows: cities.map(c => ({ id: c.id, title: c.title })),
                        },
                    ],
                },
            },
        });
    }

    /**
     * Interactive "CTA URL" card: header, body, footer and one link button.
     * Free-form messages like this are only allowed within 24h of the customer's last message.
     */
    private async sendWelcome({ to, name, url, isLoginLink, city }: WelcomeCard): Promise<void> {
        const { brand } = this;
        const intro = !city
            ? `Thanks for reaching out! ${brand.welcomeLine}`
            : city.channelCode
              ? `Tap below to shop in *${city.title}*.`
              : `Tap below and enter your pincode to shop in *${city.title}*.`;
        await this.sendMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'cta_url',
                header: { type: 'text', text: `Welcome to ${brand.name}` }, // max 60 chars
                body: {
                    // max 1024 chars
                    text:
                        `Hi ${name || 'there'},\n\n` +
                        `${intro}\n\n` +
                        (isLoginLink
                            ? `This button logs you straight in — please don't share it.\n\n`
                            : '') +
                        brand.tagline,
                },
                footer: { text: brand.name }, // max 60 chars
                action: {
                    name: 'cta_url',
                    parameters: {
                        display_text: 'Order now', // max 20 chars
                        url,
                    },
                },
            },
        });
    }

    /**
     * Meta's REQUEST_CONTACT_INFO button. Addressed by BSUID (`recipient`, not `to`)
     * because we don't know the phone yet. Tapping it shares the user's own number.
     */
    private async sendPhoneRequest(userId: string): Promise<void> {
        await this.sendMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            recipient: userId,
            type: 'interactive',
            interactive: {
                type: 'request_contact_info',
                body: {
                    text:
                        `Welcome to ${this.brand.name}! Share your phone number and we will send you ` +
                        'a link that logs you straight in to order.',
                },
                action: { name: 'request_contact_info' },
            },
        });
    }

    /**
     * Confirmation card for an order placed through a WhatsApp login link, with a
     * "View order" button to the storefront's order history. Free-form, so it
     * relies on the customer having messaged us within 24h (see
     * WHATSAPP_ORDER_WINDOW_MS).
     */
    async sendOrderPlaced({ to, name, orderCode, total }: WhatsappOrderPlacedMessage): Promise<void> {
        await this.sendMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'cta_url',
                body: {
                    // max 1024 chars
                    text:
                        `Hi ${name || 'there'},\n\n` +
                        `Your order *${orderCode}* has been placed successfully! ✅\n\n` +
                        `*Total: ${total}*\n\n` +
                        `Thank you for ordering from ${this.brand.name}. ${this.brand.tagline}`,
                },
                action: {
                    name: 'cta_url',
                    parameters: {
                        display_text: 'View order', // max 20 chars
                        url: new URL(ORDERS_PATH, this.options.storeUrl).toString(),
                    },
                },
            },
        });
    }

    /** The rider has left with the order: who they are and a tap-to-call number. */
    async sendOrderOutForDelivery({
        to,
        name,
        orderCode,
        partnerName,
        partnerPhone,
    }: WhatsappOrderOutForDeliveryMessage): Promise<void> {
        const phone = displayPhone(partnerPhone);
        await this.sendMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: {
                preview_url: false,
                // max 4096 chars
                body:
                    `Hi ${name || 'there'},\n\n` +
                    `Your order *${orderCode}* is out for delivery. 🛵\n\n` +
                    (partnerName ? `*Delivery partner:* ${partnerName}\n` : '') +
                    (partnerName && phone ? `*Phone:* ${phone}\n` : '') +
                    (partnerName ? '\n' : '') +
                    `It will reach you shortly. Please keep your phone handy.`,
            },
        });
    }

    /**
     * Delivered (or collected, for take-away), with an "Order again" button to
     * the store. A plain store link, not a login link: those are only issued
     * in reply to a message from the customer.
     */
    async sendOrderDelivered({ to, name, orderCode, isTakeaway }: WhatsappOrderDeliveredMessage): Promise<void> {
        await this.sendMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'cta_url',
                body: {
                    // max 1024 chars
                    text:
                        `Hi ${name || 'there'},\n\n` +
                        (isTakeaway
                            ? `Your order *${orderCode}* has been collected. ✅\n\n`
                            : `Your order *${orderCode}* has been delivered successfully. ✅\n\n`) +
                        `${this.brand.deliveredLine} Thank you for choosing ${this.sellerName}.`,
                },
                action: {
                    name: 'cta_url',
                    parameters: {
                        display_text: 'Order again', // max 20 chars
                        url: this.options.storeUrl,
                    },
                },
            },
        });
    }

    /** Sent right after the delivered message: a rating request with a "Rate us" button to the Play Store. */
    async sendRateApp({ to, name, playStoreUrl }: WhatsappRateAppMessage): Promise<void> {
        await this.sendMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'cta_url',
                body: {
                    // max 1024 chars
                    text:
                        `Hi ${name || 'there'}, we hope you loved your ${this.sellerName} order! 😊\n\n` +
                        `Please take a few seconds to rate us on the Play Store. Your rating helps us serve you better. ⭐`,
                },
                action: {
                    name: 'cta_url',
                    parameters: {
                        display_text: '⭐ Rate us', // max 20 chars
                        url: playStoreUrl,
                    },
                },
            },
        });
    }

    /**
     * Cancellation notice. Refunds are made by the store team (the Razorpay
     * handler issues none automatically), so an online-paid customer is told
     * the team will contact them rather than promised a refund date.
     */
    async sendOrderCancelled({ to, name, orderCode, reason, paidOnline }: WhatsappOrderCancelledMessage): Promise<void> {
        await this.sendMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'text',
            text: {
                preview_url: false,
                // max 4096 chars
                body:
                    `Hi ${name || 'there'},\n\n` +
                    `Your order *${orderCode}* has been cancelled.\n\n` +
                    (reason ? `*Reason:* ${reason}\n\n` : '') +
                    (paidOnline ? `Since you paid online, our team will contact you about your refund.\n\n` : '') +
                    `For any questions, call us on ${this.brand.supportPhone}.`,
            },
        });
    }

    /**
     * Pickup branch for a take-away order, with a "Get directions" button.
     * Deliberately NOT WhatsApp's native `location` message: a pin that carries
     * a name makes the maps app search for that name, which lists every branch
     * of the restaurant instead of the one to collect from. A link to the
     * coordinates can only open that one point.
     */
    async sendPickupPoint({ to, storeName, address, mapUrl }: WhatsappPickupPointMessage): Promise<void> {
        await this.sendMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'interactive',
            interactive: {
                type: 'cta_url',
                header: { type: 'text', text: 'Pickup location' }, // max 60 chars
                body: {
                    // max 1024 chars
                    text: `Collect your order at *${storeName}*` + (address ? `\n\n${address}` : ''),
                },
                action: {
                    name: 'cta_url',
                    parameters: {
                        display_text: 'Get directions', // max 20 chars
                        url: mapUrl,
                    },
                },
            },
        });
    }

    /**
     * Sends a PDF as a WhatsApp document. Meta only accepts a document by public
     * link or by media id, so the bytes are uploaded first (media ids stay valid
     * for 30 days) — no public URL to the invoice ever exists.
     *
     * MSG91 takes no bytes, only a link it fetches itself, so a brand sending
     * via MSG91 needs `publicUrl`. True when the send was accepted.
     */
    async sendPdf(to: string, pdf: Buffer, filename: string, caption: string, publicUrl?: string): Promise<boolean> {
        if (this.brand.sendVia === 'msg91') {
            const msg91 = this.options.msg91;
            if (!publicUrl || !msg91?.authKey || !msg91.integratedNumber) {
                Logger.warn(`Invoice ${filename} not sent: MSG91 needs a public link and MSG91 credentials`, loggerCtx);
                return false;
            }
            return this.postMsg91(msg91.authKey, {
                integrated_number: msg91.integratedNumber,
                recipient_number: to,
                content_type: 'document',
                attachment_url: publicUrl,
                filename,
                caption,
            });
        }
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', 'application/pdf');
        form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
        const res = await fetch(this.graphUrl('media'), {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.options.accessToken}` },
            body: form,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (!res.ok) {
            Logger.error(`Media upload failed (${res.status}): ${await res.text()}`, loggerCtx);
            return false;
        }
        const { id } = (await res.json()) as { id: string };
        return this.sendMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'document',
            document: { id, filename, caption }, // caption max 1024 chars
        });
    }

    private graphUrl(edge: 'messages' | 'media'): string {
        const version = this.options.graphApiVersion ?? DEFAULT_GRAPH_API_VERSION;
        return `https://graph.facebook.com/${version}/${this.options.phoneNumberId}/${edge}`;
    }

    /** Every message is built in Cloud API shape; sendViaMsg91 translates it. True when the send was accepted. */
    private async sendMessage(body: Record<string, unknown>): Promise<boolean> {
        if (this.brand.sendVia === 'msg91') {
            return this.sendViaMsg91(body as unknown as CloudApiMessage);
        }
        const res = await fetch(this.graphUrl('messages'), {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.options.accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (!res.ok) {
            Logger.error(`Send failed (${res.status}): ${await res.text()}`, loggerCtx);
        }
        return res.ok;
    }

    /**
     * MSG91's session-message API takes the same `interactive` object as the
     * Cloud API, with its own envelope. Replies sent this way also show in the
     * MSG91 Hello inbox. A link card (cta_url) that MSG91 rejects is resent as
     * plain text with the link, so the customer still gets it.
     */
    private async sendViaMsg91(message: CloudApiMessage): Promise<boolean> {
        const msg91 = this.options.msg91;
        if (!msg91?.authKey || !msg91.integratedNumber) {
            Logger.error('MSG91 send skipped: MSG91_AUTH_KEY / MSG91_HELLO_NUMBER not set', loggerCtx);
            return false;
        }
        if (!message.to) {
            // request_contact_info is addressed by BSUID, which MSG91 cannot reach.
            Logger.warn(`MSG91 cannot send ${message.interactive?.type ?? message.type} without a phone number`, loggerCtx);
            return false;
        }
        const envelope = { integrated_number: msg91.integratedNumber, recipient_number: message.to };
        if (message.type === 'text' && message.text) {
            return this.postMsg91(msg91.authKey, { ...envelope, content_type: 'text', text: message.text.body });
        }
        if (message.type === 'interactive' && message.interactive) {
            const sent = await this.postMsg91(msg91.authKey, {
                ...envelope,
                content_type: 'interactive',
                interactive: message.interactive,
            });
            const link = message.interactive.action?.parameters;
            if (!sent && message.interactive.type === 'cta_url' && link) {
                const text = `${message.interactive.body?.text ?? ''}\n\n${link.display_text}: ${link.url}`;
                return this.postMsg91(msg91.authKey, { ...envelope, content_type: 'text', text: text.trim() });
            }
            return sent;
        }
        Logger.warn(`MSG91 send skipped: unsupported message type "${message.type}"`, loggerCtx);
        return false;
    }

    /** True when MSG91 accepted the message. It can answer 200 with `hasError`, so the body is checked too. */
    private async postMsg91(authKey: string, body: Record<string, unknown>): Promise<boolean> {
        const res = await fetch(MSG91_SEND_URL, {
            method: 'POST',
            headers: { authkey: authKey, 'Content-Type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        const text = await res.text();
        let failed = !res.ok;
        try {
            const data = JSON.parse(text) as { hasError?: boolean; status?: string };
            failed ||= data.hasError === true || data.status === 'fail';
        } catch {
            // Non-JSON body: rely on the HTTP status.
        }
        if (failed) {
            Logger.error(`MSG91 send failed (${res.status}): ${text}`, loggerCtx);
        }
        return !failed;
    }

    /** Returns false if the id was already processed. */
    private markSeen(id: string): boolean {
        if (this.seenMessageIds.has(id)) {
            return false;
        }
        if (this.seenMessageIds.size >= MAX_SEEN_IDS) {
            // Sets iterate in insertion order, so this evicts the oldest id.
            const oldest = this.seenMessageIds.values().next().value;
            if (oldest !== undefined) {
                this.seenMessageIds.delete(oldest);
            }
        }
        this.seenMessageIds.add(id);
        return true;
    }
}

/** The parts of a Cloud API message body that sendViaMsg91 reads. */
interface CloudApiMessage {
    to?: string;
    type: string;
    text?: { body: string };
    interactive?: {
        type: string;
        body?: { text: string };
        action?: { parameters?: { display_text: string; url: string } };
    };
}

/**
 * "+91 98765 43210" for an Indian mobile (stored bare or with 91), so WhatsApp
 * renders it as a tap-to-call number; anything else is shown as stored.
 */
export function displayPhone(raw: string): string {
    const mobile = /^(?:\+?91)?(\d{10})$/.exec(raw.replace(/[\s-]/g, ''))?.[1];
    return mobile ? `+91 ${mobile.slice(0, 5)} ${mobile.slice(5)}` : raw.trim();
}

import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WhatsappIncomingMessage, WhatsappPluginOptions, WhatsappWebhookPayload } from '../types';
import { WhatsappLoginService } from './whatsapp-login.service';
import { WhatsappService } from './whatsapp.service';

/**
 * SAFETY: sendMessage() POSTs to graph.facebook.com and would message a real
 * phone. Global fetch is stubbed for every test so nothing leaves the process.
 */
const fetchMock = vi.fn();

const TEST_WA_ID = '918056305724';
const TEST_PHONE = '8056305724';

const options: WhatsappPluginOptions = {
    phoneNumberId: 'PHONE_ID',
    accessToken: 'TOKEN',
    verifyToken: 'VERIFY',
    appSecret: 'SECRET',
    storeUrl: 'https://shop.test/home',
    brand: 'star-biryani',
};

function payloadWith(
    message: WhatsappIncomingMessage,
    contact?: { wa_id?: string; user_id?: string; profile?: { name?: string } },
): WhatsappWebhookPayload {
    return { entry: [{ changes: [{ value: { contacts: contact ? [contact] : [], messages: [message] } }] }] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the outgoing webhook body's shape varies per test scenario (interactive card vs contact request), so a precise type isn't practical here.
function sentBody(callIndex = 0): Record<string, any> {
    return JSON.parse(fetchMock.mock.calls[callIndex][1].body);
}

describe('WhatsappService.handleIncoming', () => {
    let mockLoginService: { issueVerified: ReturnType<typeof vi.fn> };
    let service: WhatsappService;

    beforeEach(() => {
        fetchMock.mockReset().mockResolvedValue({ ok: true, text: async () => '' });
        vi.stubGlobal('fetch', fetchMock);
        mockLoginService = { issueVerified: vi.fn().mockResolvedValue('SECRET123') };
        service = new WhatsappService(options, mockLoginService as unknown as WhatsappLoginService);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends an Indian sender a one-tap login link', async () => {
        await service.handleIncoming(
            payloadWith(
                { id: 'a1', from: TEST_WA_ID, type: 'text', text: { body: 'Hi' } },
                { wa_id: TEST_WA_ID, profile: { name: 'Sriram 🔥' } },
            ),
        );
        expect(mockLoginService.issueVerified).toHaveBeenCalledWith({ phoneNumber: TEST_PHONE, firstName: 'Sriram' });
        const actualBody = sentBody();
        expect(actualBody.to).toBe(TEST_WA_ID);
        expect(actualBody.interactive.action.parameters.url).toBe('https://shop.test/auth/whatsapp#token=SECRET123');
        expect(actualBody.interactive.body.text).toContain("don't share");
    });

    it('sends a non-Indian sender the plain store link, with no login', async () => {
        await service.handleIncoming(payloadWith({ id: 'a2', from: '14155552671', type: 'text' }));
        expect(mockLoginService.issueVerified).not.toHaveBeenCalled();
        expect(sentBody().interactive.action.parameters.url).toBe('https://shop.test/home');
    });

    it('asks a username user (no phone in the webhook) to share their number', async () => {
        await service.handleIncoming(payloadWith({ id: 'a3', from_user_id: 'IN.BSUID1', type: 'text' }));
        expect(mockLoginService.issueVerified).not.toHaveBeenCalled();
        const actualBody = sentBody();
        expect(actualBody.recipient).toBe('IN.BSUID1');
        expect(actualBody.to).toBeUndefined();
        expect(actualBody.interactive.type).toBe('request_contact_info');
    });

    it('sends the login link once the user shares their number via the button', async () => {
        await service.handleIncoming(
            payloadWith({
                id: 'a4',
                from_user_id: 'IN.BSUID1',
                type: 'contacts',
                contacts: [{ origin: 'contact_request', phones: [{ wa_id: TEST_WA_ID }] }],
            }),
        );
        expect(mockLoginService.issueVerified).toHaveBeenCalledWith({ phoneNumber: TEST_PHONE, firstName: '' });
        expect(sentBody().to).toBe(TEST_WA_ID);
    });

    it("logs in the sender, never the owner of a contact card they forwarded", async () => {
        await service.handleIncoming(
            payloadWith({
                id: 'a5',
                from: '919000000001',
                type: 'contacts',
                contacts: [{ phones: [{ wa_id: TEST_WA_ID }] }],
            }),
        );
        expect(mockLoginService.issueVerified).toHaveBeenCalledWith({ phoneNumber: '9000000001', firstName: '' });
        expect(sentBody().to).toBe('919000000001');
    });

    it('replies only once when Meta redelivers the same message id', async () => {
        const inputPayload = payloadWith({ id: 'a6', from: TEST_WA_ID, type: 'text' });
        await service.handleIncoming(inputPayload);
        await service.handleIncoming(inputPayload);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reads the profile name by BSUID when the webhook carries no phone', async () => {
        await service.handleIncoming(
            payloadWith(
                {
                    id: 'a7',
                    from_user_id: 'IN.BSUID1',
                    type: 'contacts',
                    contacts: [{ origin: 'contact_request', phones: [{ wa_id: TEST_WA_ID }] }],
                },
                { user_id: 'IN.BSUID1', profile: { name: 'Priya' } },
            ),
        );
        expect(mockLoginService.issueVerified).toHaveBeenCalledWith({ phoneNumber: TEST_PHONE, firstName: 'Priya' });
    });

    it('sender wins over a claimed contact_request share', async () => {
        await service.handleIncoming(
            payloadWith({
                id: 'a8',
                from: '919000000001',
                type: 'contacts',
                contacts: [{ origin: 'contact_request', phones: [{ wa_id: TEST_WA_ID }] }],
            }),
        );
        expect(mockLoginService.issueVerified).toHaveBeenCalledWith({ phoneNumber: '9000000001', firstName: '' });
        expect(sentBody().to).toBe('919000000001');
    });

    it('a username user forwarding an ordinary contact card gets the phone request, not a login', async () => {
        await service.handleIncoming(
            payloadWith({
                id: 'a9',
                from_user_id: 'IN.BSUID2',
                type: 'contacts',
                contacts: [{ phones: [{ wa_id: TEST_WA_ID }] }],
            }),
        );
        expect(mockLoginService.issueVerified).not.toHaveBeenCalled();
        expect(sentBody().interactive.type).toBe('request_contact_info');
    });

    it("ignores a message sent to another of the app's numbers", async () => {
        const payload = payloadWith({ id: 'p1', from: TEST_WA_ID, type: 'text' });
        payload.entry![0].changes![0].value!.metadata = { phone_number_id: 'OTHER_PHONE_ID' };
        await service.handleIncoming(payload);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers a message sent to our own number', async () => {
        const payload = payloadWith({ id: 'p2', from: TEST_WA_ID, type: 'text' });
        payload.entry![0].changes![0].value!.metadata = { phone_number_id: 'PHONE_ID' };
        await service.handleIncoming(payload);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('ignores a reaction to our card so it does not trigger another one', async () => {
        await service.handleIncoming(payloadWith({ id: 'r1', from: TEST_WA_ID, type: 'reaction' }));
        expect(mockLoginService.issueVerified).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers a later message in the same batch even if an earlier one failed', async () => {
        mockLoginService.issueVerified.mockReset();
        mockLoginService.issueVerified
            .mockRejectedValueOnce(new Error('db down'))
            .mockResolvedValueOnce('SECRET123');
        const twoMessagePayload: WhatsappWebhookPayload = {
            entry: [
                {
                    changes: [
                        {
                            value: {
                                contacts: [{ wa_id: TEST_WA_ID, profile: { name: 'Sriram' } }],
                                messages: [
                                    { id: 'b1', from: TEST_WA_ID, type: 'text' },
                                    { id: 'b2', from: TEST_WA_ID, type: 'text' },
                                ],
                            },
                        },
                    ],
                },
            ],
        };
        await service.handleIncoming(twoMessagePayload);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(sentBody().interactive.action.parameters.url).toBe('https://shop.test/auth/whatsapp#token=SECRET123');
    });
});

describe('WhatsappService.handleIncoming for a brand with cities (kaaikani)', () => {
    let mockLoginService: { issueVerified: ReturnType<typeof vi.fn>; findChannelToken: ReturnType<typeof vi.fn> };
    let service: WhatsappService;

    function buttonTap(id: string, buttonId: string, from = TEST_WA_ID): WhatsappIncomingMessage {
        return { id, from, type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: buttonId } } };
    }

    function cityReply(id: string, rowId: string): WhatsappIncomingMessage {
        return { id, from: TEST_WA_ID, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: rowId } } };
    }

    beforeEach(() => {
        fetchMock.mockReset().mockResolvedValue({ ok: true, text: async () => '' });
        vi.stubGlobal('fetch', fetchMock);
        mockLoginService = {
            issueVerified: vi.fn().mockResolvedValue('SECRET123'),
            findChannelToken: vi.fn().mockResolvedValue('MDU_TOKEN'),
        };
        service = new WhatsappService(
            { ...options, brand: 'kaaikani', msg91: { authKey: 'MSG91_KEY', integratedNumber: '919840089302' } },
            mockLoginService as unknown as WhatsappLoginService,
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each(['Hi', 'hello sir', 'is tomato available today?', 'where is my order'])('answers "%s" with the order/support menu', async text => {
        await service.handleIncoming(
            payloadWith(
                { id: `g-${text}`, from: TEST_WA_ID, type: 'text', text: { body: text } },
                { wa_id: TEST_WA_ID, profile: { name: 'Priya' } },
            ),
        );
        expect(mockLoginService.issueVerified).not.toHaveBeenCalled();
        const body = sentBody();
        expect(body.interactive.type).toBe('button');
        expect(body.interactive.body.text).toContain('Hi Priya');
        expect(body.interactive.action.buttons.map((b: { reply: { id: string } }) => b.reply.id)).toEqual([
            'menu_order',
            'menu_support',
        ]);
    });

    it.each([
        ['a photo', { type: 'image' }],
        ['a forwarded contact card', { type: 'contacts', contacts: [{ phones: [{ wa_id: '919000000001' }] }] }],
    ])('answers %s with the menu too', async (_label, partial) => {
        await service.handleIncoming(payloadWith({ id: `s-${_label}`, from: TEST_WA_ID, ...partial } as WhatsappIncomingMessage));
        expect(sentBody().interactive.type).toBe('button');
        expect(mockLoginService.issueVerified).not.toHaveBeenCalled();
    });

    it('answers a Support tap with Chat with us / Call us options', async () => {
        await service.handleIncoming(payloadWith(buttonTap('m0', 'menu_support')));
        const body = sentBody();
        expect(body.interactive.type).toBe('button');
        expect(body.interactive.action.buttons.map((b: { reply: { id: string } }) => b.reply.id)).toEqual([
            'support_chat',
            'support_call',
        ]);
        expect(mockLoginService.issueVerified).not.toHaveBeenCalled();
    });

    it('answers a Call us tap with the toll-free customer-care number', async () => {
        await service.handleIncoming(payloadWith(buttonTap('m2', 'support_call')));
        const body = sentBody();
        expect(body).toMatchObject({ recipient_number: TEST_WA_ID, content_type: 'text' });
        expect(body.text).toContain('1800 309 4983');
        expect(mockLoginService.issueVerified).not.toHaveBeenCalled();
    });

    it('answers a Chat with us tap with a chat link to the support number', async () => {
        await service.handleIncoming(payloadWith(buttonTap('m1', 'support_chat')));
        const body = sentBody();
        expect(body).toMatchObject({ recipient_number: TEST_WA_ID, content_type: 'interactive' });
        expect(body.interactive.type).toBe('cta_url');
        expect(body.interactive.body.text).toContain('+91 98946 81385');
        expect(body.interactive.action.parameters).toEqual({
            display_text: 'Chat with support',
            url: 'https://wa.me/919894681385?text=Hi%2C%20I%20need%20help%20with%20my%20order',
        });
        expect(mockLoginService.issueVerified).not.toHaveBeenCalled();
    });

    it('resends the support link as text when MSG91 rejects the link card', async () => {
        fetchMock
            .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ hasError: true }) })
            .mockResolvedValueOnce({ ok: true, text: async () => '{}' });
        await service.handleIncoming(payloadWith(buttonTap('m3', 'support_chat')));
        expect(sentBody(1).text).toContain('Chat with support: https://wa.me/919894681385?text=');
    });

    it('sends through MSG91, never the Cloud API, with the interactive object unchanged', async () => {
        await service.handleIncoming(payloadWith({ id: 'x1', from: TEST_WA_ID, type: 'text', text: { body: 'hi' } }));
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/');
        expect(init.headers.authkey).toBe('MSG91_KEY');
        const body = sentBody();
        expect(body).toMatchObject({
            integrated_number: '919840089302',
            recipient_number: TEST_WA_ID,
            content_type: 'interactive',
        });
        expect(body.interactive.type).toBe('button');
    });

    it('resends the order link as text when MSG91 rejects the link card', async () => {
        fetchMock
            .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ hasError: true, errors: 'unsupported' }) })
            .mockResolvedValueOnce({ ok: true, text: async () => '{}' });
        await service.handleIncoming(payloadWith(cityReply('x2', 'madurai')));
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const fallback = sentBody(1);
        expect(fallback.content_type).toBe('text');
        expect(fallback.text).toContain(
            'Order now: https://shop.test/auth/whatsapp#token=SECRET123&city=Madurai&channel=MDU_TOKEN',
        );
    });

    it('does not resend a rejected menu as text', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' });
        await service.handleIncoming(payloadWith({ id: 'x3', from: TEST_WA_ID, type: 'text', text: { body: 'hi' } }));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sends nothing when the MSG91 credentials are missing', async () => {
        const unconfigured = new WhatsappService(
            { ...options, brand: 'kaaikani' },
            mockLoginService as unknown as WhatsappLoginService,
        );
        await unconfigured.handleIncoming(payloadWith({ id: 'x4', from: TEST_WA_ID, type: 'text', text: { body: 'hi' } }));
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends no invoice PDF over MSG91 without a public link', async () => {
        expect(await service.sendPdf(TEST_WA_ID, Buffer.from('%PDF'), 'Invoice.pdf', 'Invoice')).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends the invoice PDF over MSG91 by its public link', async () => {
        const url = 'https://cdn.kaaikani.co.in/reports/2026-10-09/invoice.pdf';
        expect(await service.sendPdf(TEST_WA_ID, Buffer.from('%PDF'), 'Invoice-ABC123.pdf', 'Invoice K-1', url)).toBe(
            true,
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            integrated_number: '919840089302',
            recipient_number: TEST_WA_ID,
            content_type: 'document',
            attachment_url: url,
            filename: 'Invoice-ABC123.pdf',
            caption: 'Invoice K-1',
        });
    });

    it('answers Place new order with the city list', async () => {
        await service.handleIncoming(
            payloadWith(buttonTap('m2', 'menu_order'), { wa_id: TEST_WA_ID, profile: { name: 'Priya' } }),
        );
        expect(mockLoginService.issueVerified).not.toHaveBeenCalled();
        const body = sentBody();
        expect(body.interactive.type).toBe('list');
        expect(body.interactive.body.text).toContain('Hi Priya');
        expect(body.interactive.action.sections[0].rows.map((r: { title: string }) => r.title)).toEqual([
            'Coimbatore',
            'Thodupuzha',
            'Madurai',
            'Salem',
            'Trichy',
        ]);
    });

    it('sends a login link into the picked city channel', async () => {
        await service.handleIncoming(payloadWith(cityReply('c2', 'madurai')));
        expect(mockLoginService.findChannelToken).toHaveBeenCalledWith('Madurai');
        expect(mockLoginService.issueVerified).toHaveBeenCalledWith({ phoneNumber: TEST_PHONE, firstName: '' });
        const body = sentBody();
        expect(body.interactive.action.parameters.url).toBe(
            'https://shop.test/auth/whatsapp#token=SECRET123&city=Madurai&channel=MDU_TOKEN',
        );
        expect(body.interactive.body.text).toContain('shop in *Madurai*');
    });

    it('sends Coimbatore without a channel, so the storefront asks for the pincode', async () => {
        await service.handleIncoming(payloadWith(cityReply('c3', 'coimbatore')));
        expect(mockLoginService.findChannelToken).not.toHaveBeenCalled();
        const body = sentBody();
        expect(body.interactive.action.parameters.url).toBe('https://shop.test/auth/whatsapp#token=SECRET123&city=Coimbatore');
        expect(body.interactive.body.text).toContain('enter your pincode');
    });

    it('falls back to the pincode when the city channel no longer exists', async () => {
        mockLoginService.findChannelToken.mockResolvedValue(null);
        await service.handleIncoming(payloadWith(cityReply('c4', 'salem')));
        expect(sentBody().interactive.action.parameters.url).toBe('https://shop.test/auth/whatsapp#token=SECRET123&city=Salem');
    });

    it('sends the list again for a reply that is not one of our cities', async () => {
        await service.handleIncoming(payloadWith(cityReply('c5', 'chennai')));
        expect(mockLoginService.issueVerified).not.toHaveBeenCalled();
        expect(sentBody().interactive.type).toBe('list');
    });

    it('sends a non-Indian sender who taps Place new order the plain store link', async () => {
        await service.handleIncoming(payloadWith(buttonTap('c6', 'menu_order', '14155552671')));
        expect(mockLoginService.issueVerified).not.toHaveBeenCalled();
        expect(sentBody().interactive.action.parameters.url).toBe('https://shop.test/home');
    });

    it('cannot ask a username user for their phone over MSG91, but shows the menu once a phone arrives', async () => {
        await service.handleIncoming(payloadWith({ id: 'u1', from_user_id: 'IN.BSUID1', type: 'text', text: { body: 'hi' } }));
        expect(fetchMock).not.toHaveBeenCalled();
        await service.handleIncoming(
            payloadWith({
                id: 'u2',
                from_user_id: 'IN.BSUID1',
                type: 'contacts',
                contacts: [{ origin: 'contact_request', phones: [{ wa_id: TEST_WA_ID }] }],
            }),
        );
        expect(sentBody(0).interactive.type).toBe('button');
        expect(sentBody(0).recipient_number).toBe(TEST_WA_ID);
    });
});

describe('WhatsappService tester-only mode', () => {
    beforeEach(() => {
        fetchMock.mockReset().mockResolvedValue({ ok: true, text: async () => '' });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function serviceWithTesters(testNumbers: string[]): WhatsappService {
        return new WhatsappService({ ...options, testNumbers }, {
            issueVerified: vi.fn().mockResolvedValue('SECRET123'),
        } as unknown as WhatsappLoginService);
    }

    it('ignores a sender who is not on the tester list', async () => {
        await serviceWithTesters(['919000000001']).handleIncoming(
            payloadWith({ id: 't1', from: TEST_WA_ID, type: 'text', text: { body: 'hi' } }),
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers a sender on the tester list', async () => {
        await serviceWithTesters([TEST_WA_ID]).handleIncoming(
            payloadWith({ id: 't2', from: TEST_WA_ID, type: 'text', text: { body: 'hi' } }),
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('answers everyone when the list is empty', async () => {
        await serviceWithTesters([]).handleIncoming(payloadWith({ id: 't3', from: TEST_WA_ID, type: 'text', text: { body: 'hi' } }));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('WhatsappService.brand', () => {
    it('throws for an unknown WA_BRAND rather than sending another business\'s wording', () => {
        const service = new WhatsappService({ ...options, brand: '' }, {} as WhatsappLoginService);
        expect(() => service.brand).toThrow('Unknown WhatsApp brand');
    });
});

describe('WhatsappService.isValidSignature', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));

    function signatureFor(secret: string, payload: Buffer): string {
        return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    }

    function buildService(overrides: Partial<WhatsappPluginOptions> = {}): WhatsappService {
        return new WhatsappService({ ...options, ...overrides }, {} as unknown as WhatsappLoginService);
    }

    it('accepts a signature computed with the correct secret', () => {
        const service = buildService();
        expect(service.isValidSignature(body, signatureFor('SECRET', body))).toBe(true);
    });

    it('rejects a signature computed over a different body', () => {
        const service = buildService();
        const tamperedBody = Buffer.from(JSON.stringify({ hello: 'tampered' }));
        expect(service.isValidSignature(tamperedBody, signatureFor('SECRET', body))).toBe(false);
    });

    it('rejects a missing signature header', () => {
        const service = buildService();
        expect(service.isValidSignature(body, undefined)).toBe(false);
    });

    it('rejects a header without the sha256= prefix', () => {
        const service = buildService();
        const rawHex = createHmac('sha256', 'SECRET').update(body).digest('hex');
        expect(service.isValidSignature(body, rawHex)).toBe(false);
    });

    it('rejects hex of the wrong length', () => {
        const service = buildService();
        expect(service.isValidSignature(body, 'sha256=abcd')).toBe(false);
    });

    it('fails closed when appSecret is empty, even against a signature made with an empty key', () => {
        const service = buildService({ appSecret: '' });
        expect(service.isValidSignature(body, signatureFor('', body))).toBe(false);
    });
});

describe('WhatsappService.sendOrderPlaced', () => {
    beforeEach(() => {
        fetchMock.mockReset().mockResolvedValue({ ok: true, text: async () => '' });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends a confirmation card with the total and a View order button, without the items', async () => {
        const service = new WhatsappService(options, {} as WhatsappLoginService);
        await service.sendOrderPlaced({ to: TEST_WA_ID, name: 'Sriram', orderCode: 'ABC123', total: '₹1,250.00' });
        const actualBody = sentBody();
        expect(actualBody.to).toBe(TEST_WA_ID);
        expect(actualBody.interactive.type).toBe('cta_url');
        const text = actualBody.interactive.body.text;
        expect(text).toContain('Hi Sriram');
        expect(text).toContain('*ABC123* has been placed successfully');
        expect(text).toContain('*Total: ₹1,250.00*');
        expect(text).not.toContain('×');
        expect(actualBody.interactive.action.parameters).toEqual({
            display_text: 'View order',
            url: 'https://shop.test/account/history',
        });
    });
});

describe('WhatsappService out for delivery / delivered / cancelled', () => {
    beforeEach(() => {
        fetchMock.mockReset().mockResolvedValue({ ok: true, text: async () => '' });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each([
        ['9876543210', '+91 98765 43210'],
        ['+91 98765-43210', '+91 98765 43210'],
        ['919876543210', '+91 98765 43210'],
        ['04174 247373', '04174 247373'],
    ])('sends out-for-delivery with the rider, showing phone %s as %s', async (stored, shown) => {
        const service = new WhatsappService(options, {} as WhatsappLoginService);
        await service.sendOrderOutForDelivery({
            to: TEST_WA_ID,
            name: 'Sriram',
            orderCode: 'ABC123',
            partnerName: 'Ravi Kumar',
            partnerPhone: stored,
        });
        const body = sentBody();
        expect(body.to).toBe(TEST_WA_ID);
        expect(body.text.body).toContain('Hi Sriram');
        expect(body.text.body).toContain('*ABC123* is out for delivery');
        expect(body.text.body).toContain('*Delivery partner:* Ravi Kumar');
        expect(body.text.body).toContain(`*Phone:* ${shown}`);
    });

    it('leaves out the rider block when no rider is recorded', async () => {
        const service = new WhatsappService(options, {} as WhatsappLoginService);
        await service.sendOrderOutForDelivery({
            to: TEST_WA_ID,
            name: 'Sriram',
            orderCode: 'ABC123',
            partnerName: '',
            partnerPhone: '9876543210',
        });
        const text = sentBody().text.body;
        expect(text).toContain('is out for delivery');
        expect(text).not.toContain('Delivery partner');
        expect(text).not.toContain('Phone:');
    });

    it('sends a delivered card with an Order again button to the store', async () => {
        const service = new WhatsappService(options, {} as WhatsappLoginService);
        await service.sendOrderDelivered({ to: TEST_WA_ID, name: 'Sriram', orderCode: 'ABC123', isTakeaway: false });
        const body = sentBody();
        expect(body.interactive.body.text).toContain('*ABC123* has been delivered successfully');
        expect(body.interactive.action.parameters).toEqual({ display_text: 'Order again', url: options.storeUrl });
    });

    it('sends the rating request with a Rate us button to the Play Store page', async () => {
        const service = new WhatsappService(options, {} as WhatsappLoginService);
        const playStoreUrl = 'https://play.google.com/store/apps/details?id=com.example';
        await service.sendRateApp({ to: TEST_WA_ID, name: 'Sriram', playStoreUrl });
        const body = sentBody();
        expect(body.interactive.body.text).toContain('Hi Sriram');
        expect(body.interactive.body.text).toContain('rate us on the Play Store');
        expect(body.interactive.action.parameters).toEqual({ display_text: '⭐ Rate us', url: playStoreUrl });
    });

    it('says collected, not delivered, for take-away', async () => {
        const service = new WhatsappService(options, {} as WhatsappLoginService);
        await service.sendOrderDelivered({ to: TEST_WA_ID, name: 'Sriram', orderCode: 'ABC123', isTakeaway: true });
        const text = sentBody().interactive.body.text;
        expect(text).toContain('has been collected');
        expect(text).not.toContain('delivered');
    });

    it('sends the cancellation with the reason, the refund note and the store phone', async () => {
        const service = new WhatsappService(options, {} as WhatsappLoginService);
        await service.sendOrderCancelled({
            to: TEST_WA_ID,
            name: 'Sriram',
            orderCode: 'ABC123',
            reason: 'Ordered by mistake',
            paidOnline: true,
        });
        const text = sentBody().text.body;
        expect(text).toContain('*ABC123* has been cancelled');
        expect(text).toContain('*Reason:* Ordered by mistake');
        expect(text).toContain('our team will contact you about your refund');
        expect(text).toContain('call us on +91 4174 247373');
    });

    it('leaves out the reason and refund lines when neither applies', async () => {
        const service = new WhatsappService(options, {} as WhatsappLoginService);
        await service.sendOrderCancelled({ to: TEST_WA_ID, name: '', orderCode: 'ABC123', reason: '', paidOnline: false });
        const text = sentBody().text.body;
        expect(text).not.toContain('Reason');
        expect(text).not.toContain('refund');
    });
});

describe('WhatsappService.sendPickupPoint', () => {
    beforeEach(() => {
        fetchMock.mockReset().mockResolvedValue({ ok: true, text: async () => '' });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends the branch address with a directions button, not a named location pin', async () => {
        const service = new WhatsappService(options, {} as WhatsappLoginService);
        const mapUrl = 'https://www.google.com/maps/search/?api=1&query=12.79,78.71';
        await service.sendPickupPoint({ to: TEST_WA_ID, storeName: 'Store', address: 'Ambur', mapUrl });
        const actualBody = sentBody();
        expect(actualBody.type).toBe('interactive');
        expect(actualBody.location).toBeUndefined();
        expect(actualBody.interactive.body.text).toBe('Collect your order at *Store*\n\nAmbur');
        expect(actualBody.interactive.action.parameters).toEqual({ display_text: 'Get directions', url: mapUrl });
    });
});

describe('WhatsappService.sendPdf', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('uploads the PDF, then sends it as a document by media id', async () => {
        fetchMock
            .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'MEDIA1' }) })
            .mockResolvedValueOnce({ ok: true, text: async () => '' });
        const service = new WhatsappService(options, {} as WhatsappLoginService);
        await service.sendPdf(TEST_WA_ID, Buffer.from('%PDF-1.3'), 'Invoice-ABC123.pdf', 'Invoice S-07');

        const [uploadUrl, upload] = fetchMock.mock.calls[0];
        expect(uploadUrl).toMatch(/\/PHONE_ID\/media$/);
        expect(upload.body.get('type')).toBe('application/pdf');
        expect(upload.body.get('file').name).toBe('Invoice-ABC123.pdf');

        expect(fetchMock.mock.calls[1][0]).toMatch(/\/PHONE_ID\/messages$/);
        expect(sentBody(1)).toMatchObject({
            to: TEST_WA_ID,
            type: 'document',
            document: { id: 'MEDIA1', filename: 'Invoice-ABC123.pdf', caption: 'Invoice S-07' },
        });
    });

    it('sends no message when the upload is rejected', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'bad file' });
        const service = new WhatsappService(options, {} as WhatsappLoginService);
        await service.sendPdf(TEST_WA_ID, Buffer.from('x'), 'a.pdf', 'c');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

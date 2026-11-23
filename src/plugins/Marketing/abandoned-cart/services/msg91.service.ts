import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { buildWhatsappComponents } from '../functions/build-components';
import { normalizePhone } from '../functions/normalize-phone';
import { SendWhatsappArgs } from '../types';

@Injectable()
export class Msg91Service {
    // Auth key is a secret — never hardcode it. Missing env -> sends are skipped (see guard below).
    private readonly authKey = process.env.MSG91_AUTH_KEY ?? '';
    // Defaults to the "whatsapp bulk" number (919840089302) that owns the kaaikani WhatsApp
    // templates, and its namespace. env overrides for prod / a different sending number.
    private readonly integratedNumber = process.env.MSG91_HELLO_NUMBER ?? '919840089302';
    private readonly templateNamespace = process.env.MSG91_TEMPLATE_NAMESPACE ?? '892ba9fb_05ed_45d4_aea2_95ad4effe7c9';
    private readonly url = 'https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/';

    /** Sends one WhatsApp utility template to the customer. Never throws into the sweep. */
    async sendAbandonedCartWhatsapp(args: SendWhatsappArgs): Promise<boolean> {
        if (!this.authKey || !this.integratedNumber) {
            console.error('[AbandonedCart][MSG91] missing MSG91_AUTH_KEY / MSG91_HELLO_NUMBER; skipping send');
            return false;
        }
        const to = normalizePhone(args.phone);
        const payload = {
            integrated_number: this.integratedNumber,
            content_type: 'template',
            payload: {
                messaging_product: 'whatsapp',
                type: 'template',
                template: {
                    name: args.templateName,
                    language: { code: args.language, policy: 'deterministic' },
                    namespace: this.templateNamespace,
                    to_and_components: [
                        {
                            to: [to],
                            components: buildWhatsappComponents({
                                vars: args.vars,
                                headerImageUrl: args.headerImageUrl,
                                buttonUrlValue: args.buttonUrlValue,
                            }),
                        },
                    ],
                },
            },
        };
        try {
            const response = await axios.post(this.url, payload, {
                headers: { 'Content-Type': 'application/json', authkey: this.authKey },
            });
            console.log(
                `[AbandonedCart][MSG91] sent ${args.templateName} to ${to}`,
                JSON.stringify(response.data ?? {}),
            );
            return true;
        } catch (error: any) {
            console.error('[AbandonedCart][MSG91] send failed:', error.response?.data ?? error.message);
            return false;
        }
    }
}

import { Injectable } from "@nestjs/common";
import axios from "axios";
import { Logger } from "@vendure/core";

import { loggerCtx } from "../constants";

/**
 * Normalises a stored phone number into the MSG91 / WhatsApp format: digits only, with the
 * Indian country code (91). MSG91 silently drops recipients without a country code, so a bare
 * 10-digit number must be prefixed. Numbers that already carry 91 are returned untouched.
 */
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.length === 10) {
    return `91${digits}`;
  }
  return digits;
}

export interface OrderWhatsappArgs {
  /** Recipient phone (any format; normalised to 91XXXXXXXXXX). */
  phone: string;
  /** Name of the approved MSG91 WhatsApp template (e.g. "order_confirmation"). */
  templateName: string;
  /** Template language code; defaults to "en". */
  language?: string;
  /** Positional body variables, in order: body_1, body_2, ... */
  bodyValues: string[];
  /** For a template whose header is a document: a public link MSG91 fetches, and the name shown. */
  headerDocument?: { url: string; filename: string };
  /**
   * For dynamic URL buttons (`https://example.com/{{1}}`), in button order: the part
   * that replaces {{1}}. Meta fixes the start of the link in the template.
   */
  buttonUrlSuffixes?: string[];
}

/**
 * Sends an order WhatsApp template via the MSG91 bulk endpoint: the shipping-method confirmation,
 * and WhatsappOrderService's invoice / out-for-delivery / delivered templates. Self-contained so the
 * Essentials plugin stays independent of the Marketing/abandoned-cart plugin, which uses the same
 * MSG91 WhatsApp API. Reads the auth key / sending number / namespace from env, falling back to the
 * kaaikani WhatsApp bulk number + namespace that owns the templates. Never throws into the caller.
 */
@Injectable()
export class OrderWhatsappService {
  private readonly authKey = process.env.MSG91_AUTH_KEY ?? "";
  private readonly integratedNumber = process.env.MSG91_HELLO_NUMBER ?? "919840089302";
  private readonly templateNamespace =
    process.env.MSG91_TEMPLATE_NAMESPACE ?? "892ba9fb_05ed_45d4_aea2_95ad4effe7c9";
  private readonly url =
    "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/";

  async send(args: OrderWhatsappArgs): Promise<boolean> {
    if (!this.authKey || !this.integratedNumber) {
      Logger.error(
        "Missing MSG91_AUTH_KEY / MSG91_HELLO_NUMBER; skipping WhatsApp send",
        loggerCtx
      );
      return false;
    }

    const to = normalizePhone(args.phone);

    // MSG91 body variables are positional (body_1, body_2, ...). A media header
    // carries its link in `value` plus the file name, as the report sender's does.
    const components: Record<string, { type: string; value: string; filename?: string; subtype?: string }> = {};
    if (args.headerDocument) {
      components.header_1 = {
        type: "document",
        value: args.headerDocument.url,
        filename: args.headerDocument.filename,
      };
    }
    args.bodyValues.forEach((value, index) => {
      components[`body_${index + 1}`] = { type: "text", value };
    });
    args.buttonUrlSuffixes?.forEach((value, index) => {
      components[`button_${index + 1}`] = { subtype: "url", type: "text", value };
    });

    const payload = {
      integrated_number: this.integratedNumber,
      content_type: "template",
      payload: {
        messaging_product: "whatsapp",
        type: "template",
        template: {
          name: args.templateName,
          language: { code: args.language ?? "en", policy: "deterministic" },
          namespace: this.templateNamespace,
          to_and_components: [{ to: [to], components }],
        },
      },
    };

    try {
      const response = await axios.post(this.url, payload, {
        headers: { "Content-Type": "application/json", authkey: this.authKey },
      });
      // MSG91 answers 200 with a body-level error for a rejected template, so
      // the HTTP status alone is not proof of delivery.
      const body = response.data as { type?: string; message?: string } | undefined;
      if (body?.type && body.type !== "success") {
        Logger.error(
          `WhatsApp '${args.templateName}' rejected for ${to}: ${body.message ?? JSON.stringify(body)}`,
          loggerCtx
        );
        return false;
      }
      Logger.debug(
        `WhatsApp '${args.templateName}' sent to ${to}: ${JSON.stringify(
          response.data ?? {}
        )}`,
        loggerCtx
      );
      return true;
    } catch (error: any) {
      Logger.error(
        `WhatsApp send failed for ${to}: ${JSON.stringify(
          error.response?.data ?? error.message
        )}`,
        loggerCtx
      );
      return false;
    }
  }
}

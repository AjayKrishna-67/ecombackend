import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import {
  OrderPlacedEvent,
  ShippingMethodService,
  RequestContextService,
  TransactionalConnection,
  EventBus,
  Logger,
  ShippingMethod,
  EntityHydrator,
} from "@vendure/core";

import { SmsService } from "../../../../smsService";
import { formatPickupSlot, isPickupSlotSet } from "../../../Shipping/take-away/pickup-slot";
import { loggerCtx } from "../constants";
import { parseNotificationPhones } from "../functions/parse-notification-phones";
import { OrderWhatsappService } from "./order-whatsapp.service";

declare module "@vendure/core" {
  interface CustomShippingMethodFields {
    messageTemplateId?: string;
    dataType1?: string;
    dataType2?: string;
    dateType?: "today" | "tomorrow" | "day_after_tomorrow" | "hours";
    deliveryHours?: number;
    sendWhatsapp?: boolean;
    whatsappTemplateName?: string;
    /** Registered by TakeAwayPlugin: store numbers that get a WhatsApp-only alert. */
    notificationPhones?: string;
    /** Registered by TakeAwayPlugin: MSG91 WhatsApp template for those staff alerts. */
    notificationWhatsappTemplate?: string;
  }
}

@Injectable()
export class OrderSmsService implements OnApplicationBootstrap {
  constructor(
    private eventBus: EventBus,
    private shippingMethodService: ShippingMethodService,
    private requestContextService: RequestContextService,
    private connection: TransactionalConnection,
    private entityHydrator: EntityHydrator,
    private orderWhatsappService: OrderWhatsappService
  ) {}

  onApplicationBootstrap() {
    this.eventBus.ofType(OrderPlacedEvent).subscribe(async (event) => {
      try {
        await this.handleOrderPlaced(event);
      } catch (err: any) {
        Logger.error(
          `Error processing OrderPlacedEvent (SMS): ${err.message}`,
          loggerCtx,
          err.stack
        );
      }
    });
  }

  private async handleOrderPlaced(event: OrderPlacedEvent) {
    const { order, ctx } = event;

    await this.entityHydrator.hydrate(ctx, order, {
      relations: ['shippingLines', 'customer'],
    });

    if (!order.shippingLines || order.shippingLines.length === 0) {
      return;
    }

    const shippingMethodId = order.shippingLines[0].shippingMethodId;
    if (!shippingMethodId) {
      return;
    }

    try {
      const shippingMethod = await this.connection
        .getRepository(ctx, ShippingMethod)
        .findOne({
          where: { id: shippingMethodId },
        });

      if (!shippingMethod) {
        return;
      }

      const {
        messageTemplateId,
        dataType1,
        dataType2,
        dateType,
        deliveryHours,
        sendWhatsapp,
        whatsappTemplateName,
        notificationPhones,
        notificationWhatsappTemplate,
      } = shippingMethod.customFields || {};

      const whatsappEnabled = !!(sendWhatsapp && whatsappTemplateName);

      const customerPhone = order.customer?.phoneNumber;
      const formattedPhone = customerPhone
        ? customerPhone
            .replace(/^(\+91|91)/, "")
            .replace(/^0/, "")
            .replace(/[\s-]/g, "")
        : null;

      // Staff alerts (take-away "Order Notification Numbers") are
      // WhatsApp-only and use their own template — the customer's own number
      // is excluded so they never receive the staff alert about themselves.
      const staffTemplate = notificationWhatsappTemplate?.trim();
      const staffPhones = parseNotificationPhones(notificationPhones).filter(
        (phone) => phone !== formattedPhone
      );
      if (staffPhones.length > 0 && !staffTemplate) {
        Logger.warn(
          `Shipping method ${shippingMethod.code} has Order Notification Numbers but no ` +
          `Notification WhatsApp Template; skipping staff alerts for order ${order.code}`,
          loggerCtx
        );
      }

      const sendCustomer = !!formattedPhone && (!!messageTemplateId || whatsappEnabled);
      const sendStaff = staffPhones.length > 0 && !!staffTemplate;

      // Nothing to send on either path.
      if (!sendCustomer && !sendStaff) {
        return;
      }

      // Single value shared by both channels: date-only for today/tomorrow/day_after_tomorrow,
      // or date + computed delivery time (IST) when dateType === "hours".
      // A Take Away customer gets the pickup time they chose (or, failing
      // that, the store's pickup hours) instead: it is the time they agreed
      // to, not an estimate.
      const pickupTime = order.customFields?.pickupTime;
      const pickupSlot = order.customFields?.pickupSlot;
      const deliveryValue = pickupTime
        ? pickupTime
        : isPickupSlotSet(pickupSlot)
          ? formatPickupSlot(pickupSlot)
          : this.getDeliveryValue(dateType, deliveryHours);

      // --- Customer SMS (MSG91 Flow) ---
      if (sendCustomer && messageTemplateId) {
        const variables: { [key: string]: string } = {};

        if (dataType1) {
          variables[dataType1.trim()] = order.code;
        }
        if (dataType2) {
          variables[dataType2.trim()] = deliveryValue;
        }

        Logger.debug(
          `Sending SMS for Order ${order.code}. Phone: ${formattedPhone}. Template: ${messageTemplateId}. ` +
          `DateType=${dateType || 'today'}, DeliveryHours=${deliveryHours ?? '-'}, Value=${deliveryValue}`,
          loggerCtx
        );

        const smsService = new SmsService(
          messageTemplateId,
          formattedPhone!,
          variables
        );

        await smsService.sendSms();
      }

      // --- Customer WhatsApp (MSG91 bulk) ---
      if (sendCustomer && whatsappEnabled) {
        Logger.debug(
          `Sending WhatsApp for Order ${order.code}. Phone: ${formattedPhone}. ` +
          `Template: ${whatsappTemplateName}. body_1=${order.code}, body_2=${deliveryValue}`,
          loggerCtx
        );

        await this.orderWhatsappService.send({
          phone: formattedPhone!,
          templateName: whatsappTemplateName!.trim(),
          bodyValues: [order.code, deliveryValue],
        });
      }

      // --- Staff WhatsApp alerts (separate template, no SMS) ---
      // The staff template has exactly two positional body variables —
      // {{1}} = order code, {{2}} = order-placed date & time (IST) — and
      // WhatsApp rejects sends whose param count differs from the template.
      if (sendStaff) {
        const orderDateValue = this.getOrderPlacedValue();
        for (const phone of staffPhones) {
          Logger.debug(
            `Sending staff WhatsApp for Order ${order.code}. Phone: ${phone}. ` +
            `Template: ${staffTemplate}. body_1=${order.code}, body_2=${orderDateValue}`,
            loggerCtx
          );

          await this.orderWhatsappService.send({
            phone,
            templateName: staffTemplate!,
            bodyValues: [order.code, orderDateValue],
          });
        }
      }

    } catch (error: any) {
      Logger.error(
        `Failed to send SMS for order ${order.code}: ${error.message}`,
        loggerCtx,
        error.stack
      );
    }
  }

  /**
   * Computes the delivery value shown in the message, based on IST (UTC+05:30). Robust against the
   * server running in UTC: we add the IST offset to the epoch and then read/mutate the shifted
   * Date via its UTC getters/setters (which now represent IST).
   *
   * - today / tomorrow / day_after_tomorrow  ->  date only, "DD-MM-YYYY"
   * - hours                                  ->  now + deliveryHours, "DD-MM-YYYY hh:mm AM/PM"
   *
   * @param dateType      'today' | 'tomorrow' | 'day_after_tomorrow' | 'hours' (defaults to today)
   * @param deliveryHours hours to add when dateType === 'hours'
   */
  private getDeliveryValue(
    dateType: string | undefined,
    deliveryHours: number | undefined
  ): string {
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(new Date().getTime() + IST_OFFSET);

    if (dateType === "hours") {
      const hours = Number(deliveryHours);
      if (Number.isFinite(hours) && hours > 0) {
        istDate.setTime(istDate.getTime() + hours * 60 * 60 * 1000);
      }
      return this.formatDateTime(istDate);
    }

    if (dateType === "tomorrow") {
      istDate.setUTCDate(istDate.getUTCDate() + 1);
    } else if (dateType === "day_after_tomorrow") {
      istDate.setUTCDate(istDate.getUTCDate() + 2);
    }

    return this.formatDate(istDate);
  }

  /**
   * The moment the order was placed as an IST "DD-MM-YYYY hh:mm AM/PM" stamp
   * (this runs on OrderPlacedEvent, so "now" IS the order time). Used for the
   * staff alert's {{2}} — deliberately independent of the customer-facing
   * dateType config, whose value is a delivery ESTIMATE, not the order date.
   */
  private getOrderPlacedValue(): string {
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    return this.formatDateTime(new Date(new Date().getTime() + IST_OFFSET));
  }

  /** Formats an IST-shifted Date (read via UTC getters) as "DD-MM-YYYY". */
  private formatDate(istDate: Date): string {
    const day = istDate.getUTCDate().toString().padStart(2, "0");
    const month = (istDate.getUTCMonth() + 1).toString().padStart(2, "0");
    const year = istDate.getUTCFullYear();
    return `${day}-${month}-${year}`;
  }

  /** Formats an IST-shifted Date (read via UTC getters) as "DD-MM-YYYY hh:mm AM/PM". */
  private formatDateTime(istDate: Date): string {
    let hours = istDate.getUTCHours();
    const minutes = istDate.getUTCMinutes().toString().padStart(2, "0");
    const meridiem = hours >= 12 ? "PM" : "AM";
    hours = hours % 12 || 12;
    const hh = hours.toString().padStart(2, "0");
    return `${this.formatDate(istDate)} ${hh}:${minutes} ${meridiem}`;
  }
}
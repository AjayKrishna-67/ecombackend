import { CustomFieldConfig, EventBus, LanguageCode, PluginCommonModule, RequestContextService, ShippingMethodService, TransactionalConnection, Type, VendurePlugin } from '@vendure/core';

import { ORDER_SMS_PLUGIN_OPTIONS } from './constants';
import { PluginInitOptions } from './types';
import { OrderSmsService } from './services/order-sms.service';
import { OrderWhatsappService } from './services/order-whatsapp.service';
const shippingMethodCustomFields: CustomFieldConfig[] = [
  {
    name: 'messageTemplateId',
    type: 'string',
    label: [{ languageCode: LanguageCode.en, value: 'Message Template ID' }],
    description: [
      {
        languageCode: LanguageCode.en,
        value: 'ID of the message template to send after selecting this shipping method.',
      },
    ],
    nullable: true,
    public: true,
  },
  {
    name: 'dataType1',
    type: 'string',
    label: [{ languageCode: LanguageCode.en, value: 'Data Type 1' }],
    description: [
      {
        languageCode: LanguageCode.en,
        value: 'First variable name used in the message template (e.g. ##var##)',
      },
    ],
    nullable: true,
    public: true,
  },
  {
    name: 'dataType2',
    type: 'string',
    label: [{ languageCode: LanguageCode.en, value: 'Data Type 2' }],
    description: [
      {
        languageCode: LanguageCode.en,
        value: 'Second variable name used in the message template (e.g. ##Var##)',
      },
    ],
    nullable: true,
    public: true,
  },
  {
    name: "dateType",
    type: "string",
    label: [{ languageCode: LanguageCode.en, value: "Date Type for Data Type 2" }],
    description: [
      {
        languageCode: LanguageCode.en,
        value: "Select which date/time to send for Data Type 2 in the SMS / WhatsApp message",
      },
    ],
    options: [
      { value: "today", label: [{ languageCode: LanguageCode.en, value: "Today" }] },
      { value: "tomorrow", label: [{ languageCode: LanguageCode.en, value: "Tomorrow" }] },
      { value: "day_after_tomorrow", label: [{ languageCode: LanguageCode.en, value: "Day After Tomorrow" }] },
      { value: "hours", label: [{ languageCode: LanguageCode.en, value: "In X Hours (uses Delivery Hours)" }] },
    ],
    nullable: true,
    public: true,
  },
  {
    name: "deliveryHours",
    type: "int",
    label: [{ languageCode: LanguageCode.en, value: "Delivery Hours" }],
    description: [
      {
        languageCode: LanguageCode.en,
        value: "Number of hours from order placement. Used only when Date Type = 'In X Hours'; the message then shows date + computed delivery time (IST).",
      },
    ],
    min: 0,
    nullable: true,
    public: true,
  },
  {
    name: "sendWhatsapp",
    type: "boolean",
    label: [{ languageCode: LanguageCode.en, value: "Send WhatsApp" }],
    description: [
      {
        languageCode: LanguageCode.en,
        value: "When enabled, also send a WhatsApp template message (in addition to / instead of SMS) when this shipping method is used.",
      },
    ],
    defaultValue: false,
    nullable: true,
    public: true,
  },
  {
    name: "whatsappTemplateName",
    type: "string",
    label: [{ languageCode: LanguageCode.en, value: "WhatsApp Template Name" }],
    description: [
      {
        languageCode: LanguageCode.en,
        value: "Name of the approved MSG91 WhatsApp template (e.g. order_confirmation). body_1 = order code, body_2 = delivery date/time.",
      },
    ],
    nullable: true,
    public: true,
  },
]
@VendurePlugin({
  imports: [PluginCommonModule],
  providers: [
    { provide: ORDER_SMS_PLUGIN_OPTIONS, useFactory: () => ShippingMethodSmsTemplatePlugin.options },
    OrderSmsService,
    OrderWhatsappService,
  ],
  configuration: config => {
    config.customFields.ShippingMethod.push(...shippingMethodCustomFields)
    return config;
  },
  compatibility: '^3.6.3',
})
export class ShippingMethodSmsTemplatePlugin {
  static options: PluginInitOptions;

  static init(options: PluginInitOptions): Type<ShippingMethodSmsTemplatePlugin> {
    this.options = options;
    return ShippingMethodSmsTemplatePlugin;
  }
}

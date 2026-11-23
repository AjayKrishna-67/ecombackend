// src/plugins/google-email-notification/email-handlers.ts
import { EmailEventListener } from '@vendure/email-plugin';
import {
  AccountRegistrationEvent,
  OrderPlacedEvent,
  OrderStateTransitionEvent,
  CustomerService,
  Logger,
} from '@vendure/core';

const loggerCtx = 'GoogleEmailHandlers';

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
}

interface BrandConfig {
  key: string;
  displayName: string;
  handlerSuffix: string;
  channelTokens: string[];
  defaultShopUrl: string;
  shopUrlEnvVar?: string;
  defaultFromAddress: string;
  fromAddressEnvVar?: string;
  defaultSupportEmail: string;
  supportEmailEnvVar?: string;
  defaultLogoUrl: string;
  logoUrlEnvVar?: string;
  logoAlt: string;
  logoWidth: string;
  primaryColor: string;
  backgroundColor: string;
  ctaColor: string;
  accentColor: string;
  textOnPrimary: string;
  smtpConfig: {
    hostEnvVar?: string;
    defaultHost: string;
    portEnvVar?: string;
    defaultPort: number;
    secureEnvVar?: string;
    defaultSecure: boolean;
    usernameEnvVar?: string;
    defaultUsername: string;
    passwordEnvVar?: string;
    defaultPassword: string;
  };
}

interface ResolvedBrandConfig {
  key: string;
  name: string;
  handlerSuffix: string;
  channelTokens: string[];
  shopUrl: string;
  fromAddress: string;
  supportEmail: string;
  logoUrl: string;
  logoAlt: string;
  logoWidth: string;
  primaryColor: string;
  backgroundColor: string;
  ctaColor: string;
  accentColor: string;
  textOnPrimary: string;
}

const brandConfigs: BrandConfig[] = [
  {
    key: 'south-mithai',
    displayName: 'South Mithai',
    handlerSuffix: '',
    channelTokens: ['ind-Snacks', 'Ind-Snacks', 'usd-Snacks', 'Usd-Snacks'],
    defaultShopUrl: process.env.SOUTHMITHAI_SHOP_URL || 'https://southmithai.com',
    shopUrlEnvVar: 'SOUTHMITHAI_SHOP_URL',
    defaultFromAddress: process.env.SOUTHMITHAI_EMAIL_FROM || '"South Mithai" <noreply@southmithai.com>',
    fromAddressEnvVar: 'SOUTHMITHAI_EMAIL_FROM',
    defaultSupportEmail: 'support@southmithai.com',
    supportEmailEnvVar: 'SOUTHMITHAI_SUPPORT_EMAIL',
    defaultLogoUrl: 'https://s3.ap-south-1.amazonaws.com/cdn.kaaikani.co.in/southmithai.png',
    logoUrlEnvVar: 'SOUTHMITHAI_LOGO_URL',
    logoAlt: 'South Mithai Logo',
    logoWidth: '150px',
    primaryColor: '#92400e',
    backgroundColor: '#ffedc7',
    ctaColor: '#92400e',
    accentColor: '#fbbf24',
    textOnPrimary: '#fbbf24',
    smtpConfig: {
      hostEnvVar: 'SOUTHMITHAI_SMTP_HOST',
      defaultHost: 'email-smtp.ap-south-1.amazonaws.com',
      portEnvVar: 'SOUTHMITHAI_SMTP_PORT',
      defaultPort: 587,
      secureEnvVar: 'SOUTHMITHAI_SMTP_SECURE',
      defaultSecure: false, // Port 587 uses STARTTLS, not direct SSL
      usernameEnvVar: 'SOUTHMITHAI_SMTP_USERNAME',
      defaultUsername: '',
      passwordEnvVar: 'SOUTHMITHAI_SMTP_PASSWORD',
      defaultPassword: '',
    },
  },
  {
    key: 'swad-kerala',
    displayName: 'Swad Kerala',
    handlerSuffix: '-swadkerala',
    channelTokens: ['ind-Swadkerala', 'Ind-Swadkerala'],
    defaultShopUrl: process.env.SWADKERALA_SHOP_URL || 'https://swadkerala.com',
    shopUrlEnvVar: 'SWADKERALA_SHOP_URL',
    defaultFromAddress: process.env.SWADKERALA_EMAIL_FROM || '"Swad Kerala" <support@swadkerala.com>',
    fromAddressEnvVar: 'SWADKERALA_EMAIL_FROM',
    defaultSupportEmail: 'support@swadkerala.com',
    supportEmailEnvVar: 'SWADKERALA_SUPPORT_EMAIL',
    defaultLogoUrl: 'https://s3.ap-south-1.amazonaws.com/cdn.kaaikani.co.in/Logos/swadkerala.png',
    logoUrlEnvVar: 'SWADKERALA_LOGO_URL',
    logoAlt: 'Swad Kerala Logo',
    logoWidth: '100px',
    primaryColor: '#0b2545',
    backgroundColor: '#fff4e0',
    ctaColor: '#ff7043',
    accentColor: '#ffe0b2',
    textOnPrimary: '#f0f4ff',
    smtpConfig: {
      hostEnvVar: 'SWADKERALA_SMTP_HOST',
      defaultHost: 'smtppro.zoho.com',
      portEnvVar: 'SWADKERALA_SMTP_PORT',
      defaultPort: 465,
      secureEnvVar: 'SWADKERALA_SMTP_SECURE',
      defaultSecure: true,
      usernameEnvVar: 'SWADKERALA_SMTP_USERNAME',
      defaultUsername: 'support@swadkerala.com',
      passwordEnvVar: 'SWADKERALA_SMTP_PASSWORD',
      defaultPassword: '',
    },
  },
];

const resolvedBrandCache = new Map<string, ResolvedBrandConfig>();

function resolveEnvValue(envKey: string | undefined, fallback: string): string {
  if (envKey) {
    const value = process.env[envKey];
    if (value && value.trim().length > 0) {
      return value;
    }
  }
  return fallback;
}

function resolveEnvNumber(envKey: string | undefined, fallback: number): number {
  if (envKey) {
    const value = process.env[envKey];
    if (value && value.trim().length > 0) {
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return fallback;
}

function resolveEnvBoolean(envKey: string | undefined, fallback: boolean): boolean {
  if (envKey) {
    const value = process.env[envKey];
    if (value && value.trim().length > 0) {
      return value.toLowerCase() === 'true';
    }
  }
  return fallback;
}

export function getBrandConfigByChannelToken(channelToken: string | null | undefined): BrandConfig | null {
  if (!channelToken) {
    return null;
  }

  const normalizedToken = channelToken.toLowerCase();
  return brandConfigs.find((config) =>
    config.channelTokens.some((token) => token.toLowerCase() === normalizedToken)
  ) || null;
}

export function getSmtpConfigForChannel(channelToken: string | null | undefined): SmtpConfig {
  const brandConfig = getBrandConfigByChannelToken(channelToken);

  if (!brandConfig) {
    // Fallback to South Mithai (default) if channel not found
    // This is expected during initialization when there's no email context
    if (channelToken === null || channelToken === undefined) {
      Logger.debug(
        `No channel token available (likely during initialization), using South Mithai SMTP config as default`,
        loggerCtx,
      );
    } else {
      Logger.warn(
        `No brand config found for channel token "${channelToken}", using South Mithai SMTP config as fallback`,
        loggerCtx,
      );
    }
    const defaultConfig = brandConfigs[0];
    return {
      host: resolveEnvValue(defaultConfig.smtpConfig.hostEnvVar, defaultConfig.smtpConfig.defaultHost),
      port: resolveEnvNumber(defaultConfig.smtpConfig.portEnvVar, defaultConfig.smtpConfig.defaultPort),
      secure: resolveEnvBoolean(defaultConfig.smtpConfig.secureEnvVar, defaultConfig.smtpConfig.defaultSecure),
      username: resolveEnvValue(
        defaultConfig.smtpConfig.usernameEnvVar,
        defaultConfig.smtpConfig.defaultUsername,
      ),
      password: resolveEnvValue(
        defaultConfig.smtpConfig.passwordEnvVar,
        defaultConfig.smtpConfig.defaultPassword,
      ),
    };
  }

  Logger.debug(`Using SMTP config for brand: ${brandConfig.displayName} (channel: ${channelToken})`, loggerCtx);

  return {
    host: resolveEnvValue(brandConfig.smtpConfig.hostEnvVar, brandConfig.smtpConfig.defaultHost),
    port: resolveEnvNumber(brandConfig.smtpConfig.portEnvVar, brandConfig.smtpConfig.defaultPort),
    secure: resolveEnvBoolean(brandConfig.smtpConfig.secureEnvVar, brandConfig.smtpConfig.defaultSecure),
    username: resolveEnvValue(brandConfig.smtpConfig.usernameEnvVar, brandConfig.smtpConfig.defaultUsername),
    password: resolveEnvValue(brandConfig.smtpConfig.passwordEnvVar, brandConfig.smtpConfig.defaultPassword),
  };
}

function resolveBrand(config: BrandConfig): ResolvedBrandConfig {
  const cached = resolvedBrandCache.get(config.key);
  if (cached) {
    return cached;
  }

  const resolved: ResolvedBrandConfig = {
    key: config.key,
    name: config.displayName,
    handlerSuffix: config.handlerSuffix,
    channelTokens: config.channelTokens,
    shopUrl: resolveEnvValue(config.shopUrlEnvVar, config.defaultShopUrl),
    fromAddress: resolveEnvValue(config.fromAddressEnvVar, config.defaultFromAddress),
    supportEmail: resolveEnvValue(config.supportEmailEnvVar, config.defaultSupportEmail),
    logoUrl: resolveEnvValue(config.logoUrlEnvVar, config.defaultLogoUrl),
    logoAlt: config.logoAlt,
    logoWidth: config.logoWidth,
    primaryColor: config.primaryColor,
    backgroundColor: config.backgroundColor,
    ctaColor: config.ctaColor,
    accentColor: config.accentColor,
    textOnPrimary: config.textOnPrimary,
  };

  resolvedBrandCache.set(config.key, resolved);
  return resolved;
}

function matchesBrandChannel(config: BrandConfig, event: { ctx?: { channel?: { token?: string | null } } }): boolean {
  const token = event?.ctx?.channel?.token;

  if (!token) {
    Logger.warn('Email handler received event without channel token', loggerCtx);
    return false;
  }

  const matches = config.channelTokens.some((knownToken) => knownToken.toLowerCase() === token.toLowerCase());

  if (!matches) {
    Logger.debug(
      `Skipping handler for brand ${config.displayName} because event channel token ${token} does not match`,
      loggerCtx,
    );
  }

  return matches;
}

export function getBrandTemplateVars(config: BrandConfig) {
  const brand = resolveBrand(config);
  return {
    name: brand.name,
    shopUrl: brand.shopUrl,
    supportEmail: brand.supportEmail,
    logoUrl: brand.logoUrl,
    logoAlt: brand.logoAlt,
    logoWidth: brand.logoWidth,
    primaryColor: brand.primaryColor,
    backgroundColor: brand.backgroundColor,
    ctaColor: brand.ctaColor,
    accentColor: brand.accentColor,
    textOnPrimary: brand.textOnPrimary,
  };
}

// Helper function to clean order data and remove circular references
function cleanOrderData(order: any) {
  return {
    code: order.code,
    customer: order.customer
      ? {
          firstName: order.customer.firstName,
          lastName: order.customer.lastName,
          emailAddress: order.customer.emailAddress,
          phoneNumber: order.customer.phoneNumber,
        }
      : null,
    shippingAddress: order.shippingAddress
      ? {
          fullName: order.shippingAddress.fullName,
          company: order.shippingAddress.company,
          streetLine1: order.shippingAddress.streetLine1,
          streetLine2: order.shippingAddress.streetLine2,
          city: order.shippingAddress.city,
          province: order.shippingAddress.province,
          postalCode: order.shippingAddress.postalCode,
          country: order.shippingAddress.country,
          phoneNumber: order.shippingAddress.phoneNumber,
        }
      : null,
    billingAddress: order.billingAddress
      ? {
          fullName: order.billingAddress.fullName,
          company: order.billingAddress.company,
          streetLine1: order.billingAddress.streetLine1,
          streetLine2: order.billingAddress.streetLine2,
          city: order.billingAddress.city,
          province: order.billingAddress.province,
          postalCode: order.billingAddress.postalCode,
          country: order.billingAddress.country,
          phoneNumber: order.billingAddress.phoneNumber,
        }
      : null,
    lines:
      order.lines?.map((line: any) => ({
        id: line.id,
        quantity: line.quantity,
        productVariant: {
          name: line.productVariant?.name,
          sku: line.productVariant?.sku,
          featuredAsset: line.productVariant?.featuredAsset
            ? {
                preview: line.productVariant.featuredAsset.preview,
                source: line.productVariant.featuredAsset.source,
              }
            : null,
        },
        discountedLinePriceWithTax: line.discountedLinePriceWithTax,
        linePriceWithTax: line.linePriceWithTax,
      })) || [],
    discounts:
      order.discounts?.map((discount: any) => ({
        description: discount.description,
        amount: discount.amount,
      })) || [],
    shippingLines:
      order.shippingLines?.map((line: any) => ({
        shippingMethod: {
          name: line.shippingMethod?.name,
        },
        priceWithTax: line.priceWithTax,
      })) || [],
    subTotalWithTax: order.subTotalWithTax,
    totalWithTax: order.totalWithTax,
    orderPlacedAt: order.orderPlacedAt,
    payments:
      order.payments?.map((payment: any) => ({
        method: payment.method,
        state: payment.state,
        amount: payment.amount,
      })) || [],
  };
}

function createWelcomeEmailHandler(config: BrandConfig) {
  const brand = resolveBrand(config);

  return new EmailEventListener(`google-welcome-email${config.handlerSuffix}`)
    .on(AccountRegistrationEvent)
    .filter((event) => {
      try {
        if (!matchesBrandChannel(config, event)) {
          return false;
        }

        const hasGoogleAuth =
          event.user?.authenticationMethods?.some((method: any) => method.strategy === 'google') ?? false;

        Logger.info(
          `Filtering AccountRegistrationEvent for ${event.user.identifier}: brand=${brand.name}, hasGoogleAuth=${hasGoogleAuth}`,
          loggerCtx,
        );

        return hasGoogleAuth;
      } catch (error) {
        Logger.error(`Error in filter: ${error}`, loggerCtx);
        return false;
      }
    })
    .loadData(async ({ event, injector }: { event: AccountRegistrationEvent; injector: any }) => {
      try {
        Logger.info(`Loading customer data for welcome email: ${event.user.identifier}`, loggerCtx);
        const customerService = injector.get(CustomerService);
        const customer = await customerService.findOneByUserId(event.ctx, event.user.id);
        Logger.info(
          `Customer data loaded for brand ${brand.name}: ${customer?.firstName ?? ''} ${customer?.lastName ?? ''}`,
          loggerCtx,
        );
        return { customer };
      } catch (error) {
        Logger.error(`Error loading customer data: ${error}`, loggerCtx);
        throw error;
      }
    })
    .setRecipient((event: AccountRegistrationEvent) => {
      try {
        const recipient = event.user.identifier;
        Logger.info(`Setting email recipient: ${recipient} for brand ${brand.name}`, loggerCtx);
        return recipient;
      } catch (error) {
        Logger.error(`Error setting recipient: ${error}`, loggerCtx);
        throw error;
      }
    })
    .setFrom(brand.fromAddress)
    .setSubject(`Welcome to ${brand.name}!`)
    .setTemplateVars((event: any) => {
      try {
        const templateBrand = getBrandTemplateVars(config);

        const vars = {
          brand: templateBrand,
          customer: {
            firstName: event.data.customer?.firstName || 'Valued Customer',
            lastName: event.data.customer?.lastName || '',
            emailAddress: event.user.identifier,
          },
          shopUrl: templateBrand.shopUrl,
        };

        Logger.info(
          `Template vars set for ${event.user.identifier} (brand ${templateBrand.name}): ${JSON.stringify(vars)}`,
          loggerCtx,
        );
        Logger.info(
          `Email handler setup complete for ${event.user.identifier} on brand ${templateBrand.name}, EmailPlugin should send now`,
          loggerCtx,
        );
        return vars;
      } catch (error) {
        Logger.error(`Error setting template vars: ${error}`, loggerCtx);
        throw error;
      }
    });
}

function createOrderReceiptEmailHandler(config: BrandConfig) {
  const brand = resolveBrand(config);

  return new EmailEventListener(`google-order-receipt${config.handlerSuffix}`)
    .on(OrderPlacedEvent)
    .filter((event) => {
      try {
        if (!matchesBrandChannel(config, event)) {
          return false;
        }

        const customer = event.order.customer;
        if (!customer) {
          Logger.warn(
            `Order ${event.order.code} has no customer; skipping order receipt email for brand ${brand.name}`,
            loggerCtx,
          );
          return false;
        }

        Logger.info(
          `Filtering OrderPlacedEvent for order ${event.order.code}: sending order receipt email for brand ${brand.name}`,
          loggerCtx,
        );
        return true;
      } catch (error) {
        Logger.error(`Error in order receipt filter: ${error}`, loggerCtx);
        return false;
      }
    })
    .setRecipient((event) => event.order.customer!.emailAddress)
    .setFrom(brand.fromAddress)
    .setSubject(`Your ${brand.name} Order Receipt - {{ order.code }}`)
    .setTemplateVars((event) => {
      try {
        const cleanOrder = cleanOrderData(event.order);
        const templateBrand = getBrandTemplateVars(config);

        Logger.info(
          `Order receipt template vars set for order ${event.order.code} (brand ${templateBrand.name})`,
          loggerCtx,
        );

        return {
          order: cleanOrder,
          shippingLines: cleanOrder.shippingLines,
          brand: templateBrand,
          shopUrl: templateBrand.shopUrl,
        };
      } catch (error) {
        Logger.error(`Error setting order receipt template vars: ${error}`, loggerCtx);
        throw error;
      }
    });
}

function createOrderCancelledEmailHandler(config: BrandConfig) {
  const brand = resolveBrand(config);

  return new EmailEventListener(`google-order-cancelled${config.handlerSuffix}`)
    .on(OrderStateTransitionEvent)
    .filter((event) => {
      try {
        if (!matchesBrandChannel(config, event)) {
          return false;
        }

        const isCancelled = event.toState === 'Cancelled';
        Logger.info(
          `Filtering OrderStateTransitionEvent for order ${event.order.code} on brand ${brand.name}: toState=${event.toState}, isCancelled=${isCancelled}`,
          loggerCtx,
        );
        return isCancelled;
      } catch (error) {
        Logger.error(`Error in order cancelled filter: ${error}`, loggerCtx);
        return false;
      }
    })
    .setRecipient((event) => event.order.customer!.emailAddress)
    .setFrom(brand.fromAddress)
    .setSubject(`${brand.name} Order Cancelled - {{ order.code }}`)
    .setTemplateVars((event) => {
      try {
        const cleanOrder = cleanOrderData(event.order);
        const templateBrand = getBrandTemplateVars(config);

        Logger.info(
          `Order cancelled template vars set for order ${event.order.code} (brand ${templateBrand.name})`,
          loggerCtx,
        );

        return {
          order: cleanOrder,
          shippingLines: cleanOrder.shippingLines,
          brand: templateBrand,
          shopUrl: templateBrand.shopUrl,
        };
      } catch (error) {
        Logger.error(`Error setting order cancelled template vars: ${error}`, loggerCtx);
        throw error;
      }
    });
}

function createOrderDeliveredEmailHandler(config: BrandConfig) {
  const brand = resolveBrand(config);

  return new EmailEventListener(`google-order-delivered${config.handlerSuffix}`)
    .on(OrderStateTransitionEvent)
    .filter((event) => {
      try {
        if (!matchesBrandChannel(config, event)) {
          return false;
        }

        const isDelivered = event.toState === 'Delivered';
        Logger.info(
          `Filtering OrderStateTransitionEvent for order ${event.order.code} on brand ${brand.name}: toState=${event.toState}, isDelivered=${isDelivered}`,
          loggerCtx,
        );
        return isDelivered;
      } catch (error) {
        Logger.error(`Error in order delivered filter: ${error}`, loggerCtx);
        return false;
      }
    })
    .setRecipient((event) => event.order.customer!.emailAddress)
    .setFrom(brand.fromAddress)
    .setSubject(`${brand.name} Order Delivered - {{ order.code }}`)
    .setTemplateVars((event) => {
      try {
        const cleanOrder = cleanOrderData(event.order);
        const templateBrand = getBrandTemplateVars(config);

        Logger.info(
          `Order delivered template vars set for order ${event.order.code} (brand ${templateBrand.name})`,
          loggerCtx,
        );

        return {
          order: cleanOrder,
          shippingLines: cleanOrder.shippingLines,
          brand: templateBrand,
          shopUrl: templateBrand.shopUrl,
        };
      } catch (error) {
        Logger.error(`Error setting order delivered template vars: ${error}`, loggerCtx);
        throw error;
      }
    });
}

const southMithaiConfig = brandConfigs[0];
const swadKeralaConfig = brandConfigs[1];

export const googleWelcomeEmailHandler = createWelcomeEmailHandler(southMithaiConfig);
export const googleOrderReceiptEmailHandler = createOrderReceiptEmailHandler(southMithaiConfig);
export const googleOrderCancelledEmailHandler = createOrderCancelledEmailHandler(southMithaiConfig);
export const googleOrderDeliveredEmailHandler = createOrderDeliveredEmailHandler(southMithaiConfig);

export const swadKeralaWelcomeEmailHandler = createWelcomeEmailHandler(swadKeralaConfig);
export const swadKeralaOrderReceiptEmailHandler = createOrderReceiptEmailHandler(swadKeralaConfig);
export const swadKeralaOrderCancelledEmailHandler = createOrderCancelledEmailHandler(swadKeralaConfig);
export const swadKeralaOrderDeliveredEmailHandler = createOrderDeliveredEmailHandler(swadKeralaConfig);

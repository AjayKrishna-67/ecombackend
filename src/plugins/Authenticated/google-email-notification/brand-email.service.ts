// src/plugins/google-email-notification/brand-email.service.ts
import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import * as path from 'path';
import * as fs from 'fs';
import * as Handlebars from 'handlebars';
import mjml from 'mjml';
import {
  Logger,
  RequestContext,
  AccountRegistrationEvent,
  OrderPlacedEvent,
  OrderStateTransitionEvent,
  CustomerService,
  EntityHydrator,
} from '@vendure/core';
import { getSmtpConfigForChannel, getBrandTemplateVars, getBrandConfigByChannelToken } from './email-handlers';

const loggerCtx = 'BrandEmailService';

@Injectable()
export class BrandEmailService {
  private templateCache = new Map<string, HandlebarsTemplateDelegate>();

  constructor(
    private customerService: CustomerService,
    private entityHydrator: EntityHydrator,
  ) {}

  private loadTemplate(templateName: string): HandlebarsTemplateDelegate {
    const cached = this.templateCache.get(templateName);
    if (cached) {
      return cached;
    }

    // Templates are in subdirectories like google-order-receipt/body.hbs
    // Resolve path relative to project root (process.cwd() always returns project root)
    const projectRoot = process.cwd();
    const templatePath = path.join(projectRoot, 'static/email/templates', templateName, 'body.hbs');
    
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Template not found: ${templatePath}`);
    }
    
    const templateContent = fs.readFileSync(templatePath, 'utf-8');
    const template = Handlebars.compile(templateContent);
    
    // Load partials
    const partialsPath = path.join(projectRoot, 'static/email/templates/partials');
    if (fs.existsSync(partialsPath)) {
      const partials = fs.readdirSync(partialsPath);
      partials.forEach((partialFile) => {
        if (partialFile.endsWith('.hbs')) {
          const partialName = partialFile.replace('.hbs', '');
          const partialContent = fs.readFileSync(path.join(partialsPath, partialFile), 'utf-8');
          Handlebars.registerPartial(partialName, partialContent);
        }
      });
    }

    this.templateCache.set(templateName, template);
    return template;
  }

  private async createTransport(channelToken: string | null) {
    const smtpConfig = getSmtpConfigForChannel(channelToken);
    
    Logger.info(
      `[BrandEmailService] Creating transport for channel: ${channelToken || 'default'}, SMTP: ${smtpConfig.host}:${smtpConfig.port}`,
      loggerCtx,
    );

    const transportConfig: any = {
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: {
        user: smtpConfig.username,
        pass: smtpConfig.password,
      },
    };

    // Configure TLS/SSL based on port
    if (smtpConfig.port === 465 && smtpConfig.secure) {
      // Port 465: Direct SSL/TLS (Zoho Mail)
      transportConfig.secure = true;
      transportConfig.tls = {
        rejectUnauthorized: false,
      };
    } else if (smtpConfig.port === 587 && !smtpConfig.secure) {
      // Port 587: STARTTLS (AWS SES)
      transportConfig.secure = false;
      transportConfig.requireTLS = true;
      transportConfig.tls = {
        rejectUnauthorized: false,
      };
    }

    return nodemailer.createTransport(transportConfig);
  }

  async sendWelcomeEmail(event: AccountRegistrationEvent) {
    try {
      const channelToken = event.ctx?.channel?.token || null;
      const brandConfig = getBrandConfigByChannelToken(channelToken);
      
      if (!brandConfig) {
        Logger.warn(`No brand config found for channel ${channelToken}, skipping welcome email`, loggerCtx);
        return;
      }

      const brand = getBrandTemplateVars(brandConfig);
      const transporter = await this.createTransport(channelToken);

      // Load customer data
      const customer = await this.customerService.findOneByUserId(event.ctx, event.user.id);

      const templateVars = {
        brand,
        customer: {
          firstName: customer?.firstName || 'Valued Customer',
          lastName: customer?.lastName || '',
          emailAddress: event.user.identifier,
        },
        shopUrl: brand.shopUrl,
      };

      const template = this.loadTemplate(`google-welcome-email${brandConfig.handlerSuffix}`);
      const mjmlContent = template(templateVars);
      
      // Convert MJML to HTML
      const { html, errors } = await mjml(mjmlContent, {
        validationLevel: 'soft',
      });
      
      if (errors && errors.length > 0) {
        Logger.warn(`MJML conversion warnings for welcome email: ${JSON.stringify(errors)}`, loggerCtx);
      }

      const mailOptions = {
        from: brandConfig.defaultFromAddress,
        to: event.user.identifier,
        subject: `Welcome to ${brand.name}!`,
        html,
      };

      const smtpConfig = getSmtpConfigForChannel(channelToken);
      const info = await transporter.sendMail(mailOptions);
      Logger.info(`Welcome email sent to ${event.user.identifier} via ${smtpConfig.host}`, loggerCtx);
      
      transporter.close();
    } catch (error: any) {
      Logger.error(`Error sending welcome email: ${error.message}`, loggerCtx);
      throw error;
    }
  }

  /**
   * Currency + tax display vars shared by receipt/cancelled/delivered emails.
   * Tax rows only for Indian channels — usd channels never show tax.
   */
  private getMoneyVars(order: any, channelToken: string | null) {
    const currencySymbol = order.currencyCode === 'USD' ? '$' : '₹';
    const isUsdChannel = channelToken?.toLowerCase().startsWith('usd') ?? false;
    const taxTotal = (order.totalWithTax ?? 0) - (order.total ?? 0);
    const showTax = !isUsdChannel && taxTotal > 0;
    return { currencySymbol, showTax, taxTotal };
  }

  private cleanOrderData(order: any) {
    // Adjustment amounts are negative in Vendure; templates render their own "-" sign.
    // Negative surcharges count as discounts too — loyalty points are applied as a
    // "Loyalty Points Discount" surcharge, which order.discounts does not include.
    const promotionDiscounts =
      order.discounts?.map((discount: any) => ({
        description: discount.description,
        amount: Math.abs(discount.amountWithTax ?? discount.amount ?? 0),
      })) || [];
    const surchargeDiscounts =
      order.surcharges
        ?.filter((s: any) => (s.priceWithTax ?? s.listPrice ?? 0) < 0)
        .map((s: any) => ({
          description: s.description,
          amount: Math.abs(s.priceWithTax ?? s.listPrice ?? 0),
        })) || [];
    const discounts = [...promotionDiscounts, ...surchargeDiscounts].filter((d: any) => d.amount > 0);
    const discountTotal = discounts.reduce((sum: number, d: any) => sum + d.amount, 0);
    return {
      code: order.code,
      orderPlacedAt: order.orderPlacedAt,
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
      subTotalWithTax: order.subTotalWithTax,
      totalWithTax: order.totalWithTax,
      // Ex-tax figures for the summary breakdown: subTotalBeforeDiscount + tax
      // + shipping - discounts = totalWithTax
      subTotal: order.subTotal,
      subTotalBeforeDiscount: (order.subTotal ?? 0) + discountTotal,
      shipping: order.shipping,
      shippingLines:
        order.shippingLines?.map((line: any) => ({
          id: line.id,
          shippingMethod: line.shippingMethod?.name,
          priceWithTax: line.priceWithTax,
        })) || [],
      discounts,
      hasDiscounts: discountTotal > 0,
      payments:
        order.payments?.map((payment: any) => ({
          method: payment.method,
          amount: payment.amount,
        })) || [],
    };
  }

  async sendOrderReceiptEmail(event: OrderPlacedEvent) {
    try {
      const channelToken = event.ctx?.channel?.token || null;
      const brandConfig = getBrandConfigByChannelToken(channelToken);
      
      if (!brandConfig || !event.order.customer) {
        Logger.warn(`Cannot send order receipt: no brand config or customer`, loggerCtx);
        return;
      }

      const brand = getBrandTemplateVars(brandConfig);
      const transporter = await this.createTransport(channelToken);

      // Ensure surcharges (loyalty-point discounts) are loaded for the summary
      try {
        await this.entityHydrator.hydrate(event.ctx, event.order, { relations: ['surcharges'] });
      } catch (hydrateError: any) {
        Logger.warn(`Could not hydrate order ${event.order.code} for receipt email: ${hydrateError.message}`, loggerCtx);
      }

      // Clean order data to avoid circular references
      const orderData = this.cleanOrderData(event.order);

      const templateVars = {
        brand,
        order: orderData,
        shopUrl: brand.shopUrl,
        ...this.getMoneyVars(event.order, channelToken),
      };

      const template = this.loadTemplate(`google-order-receipt${brandConfig.handlerSuffix}`);
      const mjmlContent = template(templateVars);
      
      // Convert MJML to HTML
      const { html, errors } = await mjml(mjmlContent, {
        validationLevel: 'soft',
      });
      
      if (errors && errors.length > 0) {
        Logger.warn(`MJML conversion warnings for order receipt: ${JSON.stringify(errors)}`, loggerCtx);
      }

      const mailOptions = {
        from: brandConfig.defaultFromAddress,
        to: event.order.customer.emailAddress,
        subject: `Your ${brand.name} Order Receipt - ${event.order.code}`,
        html,
      };

      const smtpConfig = getSmtpConfigForChannel(channelToken);
      await transporter.sendMail(mailOptions);
      Logger.info(`Order receipt email sent for order ${event.order.code} via ${smtpConfig.host}`, loggerCtx);
      
      transporter.close();
    } catch (error: any) {
      Logger.error(`Error sending order receipt email: ${error.message}`, loggerCtx);
      throw error;
    }
  }

  async sendOrderCancelledEmail(event: OrderStateTransitionEvent) {
    try {
      if (event.toState !== 'Cancelled') {
        return;
      }

      const channelToken = event.ctx?.channel?.token || null;
      const brandConfig = getBrandConfigByChannelToken(channelToken);
      
      if (!brandConfig || !event.order.customer) {
        return;
      }

      const brand = getBrandTemplateVars(brandConfig);
      const transporter = await this.createTransport(channelToken);

      // OrderStateTransitionEvent orders arrive without relations — load them so
      // the template can show lines, totals and payments (missing relations just
      // leave those sections empty rather than failing the email)
      try {
        await this.entityHydrator.hydrate(event.ctx, event.order, {
          relations: ['customer', 'lines.productVariant', 'shippingLines.shippingMethod', 'payments', 'surcharges'],
        });
      } catch (hydrateError: any) {
        Logger.warn(`Could not hydrate order ${event.order.code} for cancelled email: ${hydrateError.message}`, loggerCtx);
      }

      const templateVars = {
        brand,
        order: this.cleanOrderData(event.order),
        shopUrl: brand.shopUrl,
        ...this.getMoneyVars(event.order, channelToken),
      };

      const template = this.loadTemplate(`google-order-cancelled${brandConfig.handlerSuffix}`);
      const mjmlContent = template(templateVars);
      
      // Convert MJML to HTML
      const { html, errors } = await mjml(mjmlContent, {
        validationLevel: 'soft',
      });
      
      if (errors && errors.length > 0) {
        Logger.warn(`MJML conversion warnings for order cancelled: ${JSON.stringify(errors)}`, loggerCtx);
      }

      const mailOptions = {
        from: brandConfig.defaultFromAddress,
        to: event.order.customer.emailAddress,
        subject: `${brand.name} Order Cancelled - ${event.order.code}`,
        html,
      };

      await transporter.sendMail(mailOptions);
      Logger.info(`Order cancelled email sent for order ${event.order.code}`, loggerCtx);
      
      transporter.close();
    } catch (error: any) {
      Logger.error(`Error sending order cancelled email: ${error.message}`, loggerCtx);
      throw error;
    }
  }

  async sendOrderDeliveredEmail(event: OrderStateTransitionEvent) {
    try {
      if (event.toState !== 'Delivered') {
        return;
      }

      const channelToken = event.ctx?.channel?.token || null;
      const brandConfig = getBrandConfigByChannelToken(channelToken);
      
      if (!brandConfig || !event.order.customer) {
        return;
      }

      const brand = getBrandTemplateVars(brandConfig);
      const transporter = await this.createTransport(channelToken);

      try {
        await this.entityHydrator.hydrate(event.ctx, event.order, {
          relations: ['customer', 'lines.productVariant', 'shippingLines.shippingMethod', 'payments', 'surcharges'],
        });
      } catch (hydrateError: any) {
        Logger.warn(`Could not hydrate order ${event.order.code} for delivered email: ${hydrateError.message}`, loggerCtx);
      }

      const templateVars = {
        brand,
        order: this.cleanOrderData(event.order),
        shopUrl: brand.shopUrl,
        ...this.getMoneyVars(event.order, channelToken),
      };

      const template = this.loadTemplate(`google-order-delivered${brandConfig.handlerSuffix}`);
      const mjmlContent = template(templateVars);
      
      // Convert MJML to HTML
      const { html, errors } = await mjml(mjmlContent, {
        validationLevel: 'soft',
      });
      
      if (errors && errors.length > 0) {
        Logger.warn(`MJML conversion warnings for order delivered: ${JSON.stringify(errors)}`, loggerCtx);
      }

      const mailOptions = {
        from: brandConfig.defaultFromAddress,
        to: event.order.customer.emailAddress,
        subject: `${brand.name} Order Delivered - ${event.order.code}`,
        html,
      };

      await transporter.sendMail(mailOptions);
      Logger.info(`Order delivered email sent for order ${event.order.code}`, loggerCtx);
      
      transporter.close();
    } catch (error: any) {
      Logger.error(`Error sending order delivered email: ${error.message}`, loggerCtx);
      throw error;
    }
  }
}


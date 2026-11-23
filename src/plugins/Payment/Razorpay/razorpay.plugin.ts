// Razorpay/razorpay.plugin.ts

import { PluginCommonModule, VendurePlugin, JobQueueService, ProcessContext } from '@vendure/core';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import { OnApplicationBootstrap, Inject } from '@nestjs/common';
import * as path from 'path';

// Handlers
import { razorpayPaymentHandler } from './handler/razorpay.handler';

// Entities
import { RazorpayWebhookEvent } from './entities/razorpay-webhook-event.entity';

// API Extensions
import { shopApiExtensions, adminApiExtensions } from './api/api-extensions';

// Resolvers
import { RazorpayResolver } from './api/resolver/shop/razorpay.resolver';
import { RazorpayAddPaymentResolver } from './api/resolver/shop/razorpay-add-payment.resolver';
import { RazorpayAdminResolver } from './api/resolver/admin/razorpay-admin.resolver';

// Controllers & Services
import { RazorpayWebhookController } from './service/razorpay-webhook.controller';
import { RazorpayWebhookService } from './service/razorpay-webhook.service';
import { RazorpaySettlementService } from './service/razorpay-settlement.service';
import { RazorpaySettleQueueService } from './service/razorpay-settle-queue.service';
import { RazorpayReconciliationService } from './service/razorpay-reconciliation.service';
import { RazorpayOutgoingWebhookService } from './service/razorpay-outgoing-webhook.service';

@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [RazorpayWebhookEvent],
    controllers: [RazorpayWebhookController],
    providers: [
        RazorpaySettlementService,
        RazorpaySettleQueueService,
        RazorpayWebhookService,
        RazorpayReconciliationService,
        RazorpayOutgoingWebhookService // Outgoing webhooks for external notifications
    ],
    shopApiExtensions: {
        schema: shopApiExtensions,
        // RazorpayAddPaymentResolver overrides the built-in addPaymentToOrder (no schema change).
        resolvers: [RazorpayResolver, RazorpayAddPaymentResolver],
    },
    adminApiExtensions: {
        schema: adminApiExtensions,
        resolvers: [RazorpayAdminResolver],
    },
    dashboard: './dashboard/index.tsx',
    compatibility: '^3.6.3',
    configuration: config => {
        config.paymentOptions.paymentMethodHandlers.push(razorpayPaymentHandler);

        // NOTE: Custom fields for Order entity must be configured in your main Vendure config:
        // customFields: {
        //   Order: [
        //     { name: 'razorpayOrderId', type: 'string', nullable: true },
        //     { name: 'razorpayPaymentId', type: 'string', nullable: true },
        //   ],
        // }

        return config;
    },
})
export class RazorpayPlugin implements OnApplicationBootstrap {
    private reconciliationQueue: any;
    private isRunning = false;

    constructor(
        private reconciliationService: RazorpayReconciliationService,
        private jobQueueService: JobQueueService,
        private processContext: ProcessContext,
    ) { }

    static UiExtensions: AdminUiExtension = {
        id: 'razorpay-ui',
        extensionPath: path.join(__dirname, 'ui'),
        providers: ['providers.ts'],
    };

    async onApplicationBootstrap() {
        // Create a job queue for reconciliation
        this.reconciliationQueue = await this.jobQueueService.createQueue({
            name: 'razorpay-reconciliation',
            process: async (_job) => {
                console.log('[RazorpayPlugin] Processing reconciliation job...');
                await this.reconciliationService.reconcilePendingOrders();
                console.log('[RazorpayPlugin] Reconciliation job completed.');
            },
        });

        // Only schedule jobs from the WORKER process to prevent duplicates
        // Both server and worker run onApplicationBootstrap, but we only want one scheduler
        if (!this.processContext.isWorker) {
            console.log('[RazorpayPlugin] Server process - skipping job scheduling (handled by worker)');
            return;
        }

        // Schedule reconciliation to run every 5 minutes.
        // The storefront cancelRazorpayPayment mutation reverts abandoned orders
        // instantly on modal-dismiss; this cron is the backstop for app-killed
        // sessions where no client request fires. 5 min keeps hard-kill recovery
        // fast; the 3-min age gate + per-order cooldowns bound Razorpay API load.
        // Using setInterval only to ADD jobs to the queue (not run the actual work)
        // The queue system ensures only one job runs at a time across all processes
        const SCHEDULE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

        setInterval(async () => {
            // Only schedule if we're not already running
            if (!this.isRunning) {
                this.isRunning = true;
                try {
                    console.log('[RazorpayPlugin] Adding reconciliation job to queue...');
                    await this.reconciliationQueue.add({}, { retries: 0 });
                } catch (err) {
                    console.error('[RazorpayPlugin] Failed to add reconciliation job:', err);
                } finally {
                    // Reset after a delay to prevent immediate re-scheduling
                    setTimeout(() => {
                        this.isRunning = false;
                    }, 30000); // 30 seconds cooldown
                }
            } else {
                console.log('[RazorpayPlugin] Reconciliation job already running, skipping schedule.');
            }
        }, SCHEDULE_INTERVAL_MS);

        // Run immediately on startup
        console.log('[RazorpayPlugin] Adding initial reconciliation job...');
        await this.reconciliationQueue.add({}, { retries: 0 });

        console.log('[RazorpayPlugin] Reconciliation job queue initialized. Jobs will run every 5 minutes.');
    }
}
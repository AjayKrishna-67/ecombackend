import { OnApplicationBootstrap } from '@nestjs/common';
import {
    EventBus,
    JobQueue,
    JobQueueService,
    Logger,
    OrderPlacedEvent,
    PluginCommonModule,
    ProcessContext,
    VendurePlugin,
} from '@vendure/core';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoiceSequence } from './invoice-sequence.entity';
import { InvoiceSweepService } from './invoice-sweep.service';

const loggerCtx = 'InvoiceNumberPlugin';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

@VendurePlugin({
  imports: [PluginCommonModule],
  entities: [InvoiceSequence],
  providers: [InvoiceNumberService, InvoiceSweepService],
  compatibility: '^3.6.3',
})
export class InvoiceNumberPlugin implements OnApplicationBootstrap {
  private sweepQueue: JobQueue<{}>;
  private sweepInFlight = false;

  constructor(
    private readonly eventBus: EventBus,
    private readonly invoiceNumberService: InvoiceNumberService,
    private readonly invoiceSweepService: InvoiceSweepService,
    private readonly jobQueueService: JobQueueService,
    private readonly processContext: ProcessContext,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Single source of truth: OrderPlacedEvent. Vendure fires this exactly
    // once per order when it transitions to a "placed" state, regardless of
    // whether the path was online payment, manual payment, or COD. The
    // periodic sweep below is the only safety net; assignInvoiceNumber is
    // race-safe via a pessimistic row lock on the order.
    this.eventBus.ofType(OrderPlacedEvent).subscribe(async (event) => {
      try {
        await this.invoiceNumberService.assignInvoiceNumber(event.ctx, event.order.id as number);
      } catch (err) {
        Logger.error(
          `Failed to assign invoice number to order ${event.order.id}: ${(err as Error).message}`,
          loggerCtx,
        );
      }
    });

    // Safety-net sweep: catches orders missed by live events (server down
    // during OrderPlacedEvent, state transitions the plugin doesn't watch,
    // pre-existing NULLs from past incidents). Queue is created on both
    // server and worker, but only the worker schedules new jobs to avoid
    // duplicate enqueues. The service's idempotency check guarantees safe
    // re-runs.
    this.sweepQueue = await this.jobQueueService.createQueue({
      name: 'invoice-sweep',
      process: async () => {
        await this.invoiceSweepService.sweepMissingInvoices();
      },
    });

    if (!this.processContext.isWorker) {
      return;
    }

    const scheduleSweep = async () => {
      if (this.sweepInFlight) {
        return;
      }
      this.sweepInFlight = true;
      try {
        await this.sweepQueue.add({}, { retries: 0 });
      } catch (err) {
        Logger.error(
          `Failed to enqueue invoice-sweep job: ${(err as Error).message}`,
          loggerCtx,
        );
      } finally {
        setTimeout(() => {
          this.sweepInFlight = false;
        }, 30_000);
      }
    };

    setInterval(scheduleSweep, SWEEP_INTERVAL_MS);
    await scheduleSweep();
    Logger.info(
      `Invoice sweep scheduled every ${SWEEP_INTERVAL_MS / 60_000} minutes`,
      loggerCtx,
    );
  }
}

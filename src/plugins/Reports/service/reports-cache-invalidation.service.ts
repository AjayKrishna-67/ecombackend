import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { EventBus, Logger, ProductEvent, ProductVariantEvent } from '@vendure/core';
import { merge } from 'rxjs';
import { debounceTime } from 'rxjs/operators';

import { OrdersReportService } from './orders-report.service';

const loggerCtx = 'ReportsCache';

/** Quiet period after the last catalogue event before the cache is cleared. */
const SETTLE_MS = 1000;

/**
 * Clears the cached reports when the catalogue changes.
 *
 * The bill print, sales and monthly reports are cached for ten minutes
 * (REPORTS_CACHE_TTL_MS) and print catalogue fields straight from the cached
 * row: the variant name, HSN code, shadow price. Renaming a variant therefore
 * kept the OLD name on every invoice printed for the next ten minutes, with
 * nothing on screen to explain it -- found on Madurai order XZYJTUS8LWJZQSWU,
 * whose pomegranate lines would not pick up their new names.
 *
 * Debounced rather than per event: a bulk import fires one event per variant,
 * and one clear a second after the last of them covers the lot. Order events
 * are left alone on purpose -- the ten-minute TTL was chosen for those, and
 * orders arrive all day.
 */
@Injectable()
export class ReportsCacheInvalidationService implements OnApplicationBootstrap {
    constructor(
        private readonly eventBus: EventBus,
        private readonly ordersReportService: OrdersReportService,
    ) {}

    onApplicationBootstrap() {
        merge(this.eventBus.ofType(ProductEvent), this.eventBus.ofType(ProductVariantEvent))
            .pipe(debounceTime(SETTLE_MS))
            .subscribe(() => {
                this.ordersReportService.invalidateAllReports().catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    Logger.error(`Could not clear cached reports after a catalogue change: ${message}`, loggerCtx);
                });
            });
    }
}

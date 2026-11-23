import { NgModule } from '@angular/core';
import { registerHistoryEntryComponent } from '@vendure/admin-ui/core';

import { ORDER_LINE_PRICE_UPDATED } from '../history-entry.constant';
import { PriceUpdateHistoryEntryComponent } from './components/price-update-history-entry/price-update-history-entry.component';

@NgModule({
    imports: [PriceUpdateHistoryEntryComponent],
    providers: [
        registerHistoryEntryComponent({
            type: ORDER_LINE_PRICE_UPDATED,
            component: PriceUpdateHistoryEntryComponent,
        }),
    ],
})
export class PriceUpdateUiExtensionModule {}


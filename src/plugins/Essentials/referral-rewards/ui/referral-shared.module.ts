import { NgModule } from '@angular/core';
import { SharedModule } from '@vendure/admin-ui/core';

import { ReferralListComponent } from './components/referral-list/referral-list.component';
import { ReferredByCardComponent } from './components/referred-by-card/referred-by-card.component';

@NgModule({
    imports: [SharedModule],
    declarations: [ReferralListComponent, ReferredByCardComponent],
    exports: [ReferralListComponent, ReferredByCardComponent, SharedModule],
})
export class ReferralSharedModule {}

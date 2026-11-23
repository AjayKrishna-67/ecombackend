import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { SharedModule } from '@vendure/admin-ui/core';

@Component({
    selector: 'referral-points-config',
    template: `<p>Redirecting to Rewards Points...</p>`,
    standalone: true,
    imports: [SharedModule],
})
export class ReferralPointsConfigComponent implements OnInit {
    constructor(private router: Router) {}

    ngOnInit(): void {
        this.router.navigate(['/extensions/referral-rewards/history']);
    }
}

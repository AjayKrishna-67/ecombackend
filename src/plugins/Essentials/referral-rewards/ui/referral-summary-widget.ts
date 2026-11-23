import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { DataService, SharedModule } from '@vendure/admin-ui/core';
import { Subject, BehaviorSubject, of } from 'rxjs';
import { takeUntil, distinctUntilChanged, catchError } from 'rxjs/operators';
import gql from 'graphql-tag';

interface ReferralSummary {
    totalReferrals: number;
    registered: number;
    eligible: number;
    claimed: number;
}

interface ReferralSummaryReport {
    today: ReferralSummary;
    yesterday: ReferralSummary;
    allTime: ReferralSummary;
}

const GET_REFERRAL_SUMMARY = gql`
    query GetReferralSummary {
        referralSummary {
            today { totalReferrals registered eligible claimed }
            yesterday { totalReferrals registered eligible claimed }
            allTime { totalReferrals registered eligible claimed }
        }
    }
`;

@Component({
    standalone: true,
    imports: [SharedModule],
    selector: 'referral-summary-widget',
    template: `
        <div *ngIf="!hasPermission" style="text-align: center; padding: 2rem; background-color: #fff3cd; border: 1px solid #ffc107; border-radius: 8px;">
            <p style="color: #856404; margin: 0;">You don't have permission to view referral summary.</p>
        </div>

        <div *ngIf="hasPermission && summary" class="referral-summary-container">
            <div class="period-tabs">
                <button *ngFor="let period of periods"
                        class="period-tab"
                        [class.active]="activePeriod === period.key"
                        (click)="activePeriod = period.key">
                    {{ period.label }}
                </button>
            </div>

            <div class="summary-cards" *ngIf="getActiveSummary() as data">
                <div class="summary-card total">
                    <div class="card-value">{{ data.totalReferrals }}</div>
                    <div class="card-label">Total Referrals</div>
                </div>
                <div class="summary-card registered">
                    <div class="card-value">{{ data.registered }}</div>
                    <div class="card-label">Registered</div>
                </div>
                <div class="summary-card eligible">
                    <div class="card-value">{{ data.eligible }}</div>
                    <div class="card-label">Eligible</div>
                </div>
                <div class="summary-card claimed">
                    <div class="card-value">{{ data.claimed }}</div>
                    <div class="card-label">Claimed</div>
                </div>
            </div>
        </div>
    `,
    styles: [`
        .referral-summary-container { padding: 0; }
        .period-tabs {
            display: flex;
            gap: 4px;
            margin-bottom: 16px;
            border-bottom: 2px solid #e0e0e0;
            padding-bottom: 0;
        }
        .period-tab {
            padding: 8px 16px;
            border: none;
            background: none;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            color: #666;
            border-bottom: 2px solid transparent;
            margin-bottom: -2px;
            transition: all 0.2s;
        }
        .period-tab:hover { color: #333; }
        .period-tab.active {
            color: #0366d6;
            border-bottom-color: #0366d6;
        }
        .summary-cards {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 12px;
        }
        .summary-card {
            text-align: center;
            padding: 16px 8px;
            border-radius: 8px;
            border: 1px solid #e0e0e0;
        }
        .card-value {
            font-size: 28px;
            font-weight: 700;
            line-height: 1.2;
        }
        .card-label {
            font-size: 12px;
            font-weight: 500;
            color: #666;
            margin-top: 4px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .summary-card.total { background: #f0f4ff; border-color: #c2d4ff; }
        .summary-card.total .card-value { color: #0366d6; }
        .summary-card.registered { background: #fff8e1; border-color: #ffe082; }
        .summary-card.registered .card-value { color: #f57f17; }
        .summary-card.eligible { background: #e8f5e9; border-color: #a5d6a7; }
        .summary-card.eligible .card-value { color: #2e7d32; }
        .summary-card.claimed { background: #e3f2fd; border-color: #90caf9; }
        .summary-card.claimed .card-value { color: #1565c0; }
        @media (max-width: 768px) {
            .summary-cards { grid-template-columns: repeat(2, 1fr); }
        }
    `],
})
export class ReferralSummaryWidgetComponent implements OnInit, OnDestroy {
    summary: ReferralSummaryReport | null = null;
    hasPermission = false;
    activePeriod = 'today';
    periods = [
        { key: 'today', label: 'Today' },
        { key: 'yesterday', label: 'Yesterday' },
        { key: 'allTime', label: 'All Time' },
    ];

    private destroy$ = new Subject<void>();
    private channelId$ = new BehaviorSubject<string | null>(null);

    constructor(
        private dataService: DataService,
        private cdRef: ChangeDetectorRef,
    ) {}

    ngOnInit(): void {
        this.checkPermissions();
        this.watchActiveChannel();
    }

    ngOnDestroy(): void {
        this.destroy$.next();
        this.destroy$.complete();
    }

    checkPermissions(): void {
        this.dataService
            .query<{ me: { channels: Array<{ permissions: string[] }> } }>(
                gql`query { me { channels { permissions } } }`,
            )
            .single$.subscribe({
                next: (response) => {
                    const permissions = response.me.channels?.[0]?.permissions || [];
                    this.hasPermission =
                        permissions.includes('ReferralRewards') ||
                        permissions.includes('SuperAdmin');
                    this.cdRef.detectChanges();
                },
                error: () => {
                    this.hasPermission = false;
                    this.cdRef.detectChanges();
                },
            });
    }

    watchActiveChannel(): void {
        this.dataService.client
            .userStatus()
            .mapStream(data => data.userStatus.activeChannelId)
            .pipe(distinctUntilChanged(), takeUntil(this.destroy$))
            .subscribe(channelId => {
                if (channelId) {
                    this.channelId$.next(channelId);
                    this.loadSummary();
                }
            });
    }

    loadSummary(): void {
        this.dataService
            .query<{ referralSummary: ReferralSummaryReport }>(GET_REFERRAL_SUMMARY)
            .single$.pipe(
                catchError(() => of(null)),
                takeUntil(this.destroy$),
            )
            .subscribe(result => {
                if (result) {
                    this.summary = result.referralSummary;
                }
                this.cdRef.detectChanges();
            });
    }

    getActiveSummary(): ReferralSummary | null {
        if (!this.summary) return null;
        return (this.summary as any)[this.activePeriod] ?? null;
    }
}

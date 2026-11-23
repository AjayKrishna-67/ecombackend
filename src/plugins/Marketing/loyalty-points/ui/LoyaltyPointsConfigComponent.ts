import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { DataService, NotificationService, SharedModule } from '@vendure/admin-ui/core';
import { ActivatedRoute, Router } from '@angular/router';
import gql from 'graphql-tag';

interface Channel {
  id: string;
  code: string;
  token: string;
}

interface LoyaltyPointsConfig {
  id: string;
  createdAt: string;
  updatedAt: string;
  rupeesPerPoint: number;
  pointsPerRupee: number;
  channels: Channel[];
}

interface ReferralChannelPointsConfig {
  id: string;
  points: number;
  channels: Channel[];
}

interface GetLoyaltyConfigResponse {
  loyaltyPointsConfig: LoyaltyPointsConfig | null;
}

interface GetActiveChannelResponse {
  activeChannel: { id: string; code: string };
}

interface GetReferralConfigResponse {
  referralChannelPoints: ReferralChannelPointsConfig | null;
}

interface CreateLoyaltyConfigResponse {
  createLoyaltyPointsConfig: LoyaltyPointsConfig;
}

interface UpdateLoyaltyConfigResponse {
  updateLoyaltyPointsConfig: LoyaltyPointsConfig;
}

interface DeleteLoyaltyConfigResponse {
  deleteLoyaltyPointsConfig: boolean;
}

const GET_LOYALTY_CONFIG = gql`
    query GetLoyaltyConfig {
        loyaltyPointsConfig {
            id
            createdAt
            updatedAt
            rupeesPerPoint
            pointsPerRupee
            channels {
                id
                code
                token
            }
        }
    }
`;

const GET_ACTIVE_CHANNEL = gql`
    query GetActiveChannel {
        activeChannel {
            id
            code
        }
    }
`;

const GET_REFERRAL_CONFIG = gql`
    query GetReferralChannelPoints {
        referralChannelPoints {
            id
            points
            channels {
                id
                code
            }
        }
    }
`;

@Component({
    selector: 'loyalty-points-config',
    template: `
        <vdr-page-block>
            <div class="rewards-grid">
                <vdr-card title="Point Conversion Rates">
                    <form *ngIf="configForm" [formGroup]="configForm" (ngSubmit)="save()">
                        <vdr-form-field label="Rupees per Point">
                            <input type="number" formControlName="rupeesPerPoint" />
                        </vdr-form-field>
                        <vdr-form-field label="Points per Rupee">
                            <input type="number" formControlName="pointsPerRupee" />
                        </vdr-form-field>
                        <div *ngIf="existingConfig" class="current-config">
                            <div class="config-item">
                                <span class="config-label">Rupees per Point:</span>
                                <span class="config-value">{{ existingConfig.rupeesPerPoint }}</span>
                            </div>
                            <div class="config-item">
                                <span class="config-label">Points per Rupee:</span>
                                <span class="config-value">{{ existingConfig.pointsPerRupee }}</span>
                            </div>
                        </div>
                        <div class="form-actions">
                            <button class="btn btn-primary" type="submit"
                                [disabled]="configForm.invalid || configForm.pristine">
                                {{ id ? 'Update' : 'Create' }}
                            </button>
                            <button *ngIf="id" class="btn btn-danger-outline" type="button" (click)="delete()">
                                Delete
                            </button>
                        </div>
                    </form>
                </vdr-card>
                <vdr-card title="Referral Points">
                    <p class="card-description">Points awarded when referred customer's first order is delivered</p>
                    <form *ngIf="referralForm" [formGroup]="referralForm" (ngSubmit)="saveReferral()">
                        <vdr-form-field label="Points">
                            <input type="number" formControlName="points" />
                        </vdr-form-field>
                        <div *ngIf="referralConfig" class="current-config">
                            <div class="config-item">
                                <span class="config-label">Current Points:</span>
                                <span class="config-value highlight">{{ referralConfig.points }}</span>
                            </div>
                        </div>
                        <div class="form-actions">
                            <button class="btn btn-primary" type="submit"
                                [disabled]="referralForm.invalid || referralForm.pristine">
                                {{ referralConfigId ? 'Update' : 'Create' }}
                            </button>
                            <button *ngIf="referralConfigId" class="btn btn-danger-outline" type="button"
                                (click)="deleteReferral()">
                                Delete
                            </button>
                            <button class="btn btn-sm" type="button" (click)="goToReferralHistory()">
                                <clr-icon shape="view-list"></clr-icon>
                                Referral History
                            </button>
                        </div>
                    </form>
                </vdr-card>
            </div>
        </vdr-page-block>
    `,
    styles: [`
        :host {
            display: block;
        }
        .rewards-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 24px;
        }
        @media (max-width: 768px) {
            .rewards-grid {
                grid-template-columns: 1fr;
            }
        }
        .card-description {
            color: var(--color-text-300, #6c757d);
            font-size: 13px;
            margin-bottom: 12px;
        }
        .current-config {
            margin-top: 12px;
            padding: 10px 14px;
            border-radius: 6px;
            background: var(--color-component-bg-100, #f5f5f5);
            border: 1px solid var(--color-component-border-100, #eee);
        }
        .config-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 4px 0;
        }
        .config-label {
            color: var(--color-text-300, #6c757d);
            font-size: 13px;
        }
        .config-value {
            font-weight: 600;
            font-size: 15px;
        }
        .config-value.highlight {
            color: var(--color-primary-500, #2073b5);
        }
        .form-actions {
            margin-top: 1rem;
            display: flex;
            gap: 0.75rem;
        }
    `],
    standalone: true,
    imports: [SharedModule],
})
export class LoyaltyPointsConfigComponent implements OnInit {
    configForm: FormGroup;
    referralForm: FormGroup;
    id?: string;
    referralConfigId?: string;
    currentChannelId: string | null = null;
    activeChannelCode: string = '';
    existingConfig: LoyaltyPointsConfig | null = null;
    referralConfig: ReferralChannelPointsConfig | null = null;

    constructor(
        private formBuilder: FormBuilder,
        private dataService: DataService,
        private notificationService: NotificationService,
        private route: ActivatedRoute,
        private router: Router
    ) {
        this.configForm = this.formBuilder.group({
            rupeesPerPoint: ['', [Validators.required, Validators.min(1)]],
            pointsPerRupee: ['', [Validators.required, Validators.min(1)]],
        });
        this.referralForm = this.formBuilder.group({
            points: ['', [Validators.required, Validators.min(0)]],
        });
    }

    ngOnInit() {
        this.id = this.route.snapshot.paramMap.get('id') ?? undefined;
        this.fetchActiveChannel();
    }

    private fetchActiveChannel() {
        this.dataService
            .query<GetActiveChannelResponse>(GET_ACTIVE_CHANNEL)
            .single$.subscribe({
                next: (response) => {
                    this.currentChannelId = response.activeChannel.id;
                    this.activeChannelCode = response.activeChannel.code;
                    this.loadConfig();
                    this.loadReferralConfig();
                },
                error: () => {
                    this.notificationService.error('Failed to fetch active channel');
                },
            });
    }

    private loadConfig() {
        if (!this.currentChannelId) return;
        this.dataService
            .query<GetLoyaltyConfigResponse>(GET_LOYALTY_CONFIG)
            .mapSingle(({ loyaltyPointsConfig }) => loyaltyPointsConfig)
            .subscribe({
                next: (config: LoyaltyPointsConfig | null) => {
                    this.existingConfig = config;
                    if (config) {
                        this.id = config.id;
                        this.configForm.patchValue({
                            rupeesPerPoint: config.rupeesPerPoint,
                            pointsPerRupee: config.pointsPerRupee,
                        });
                    } else {
                        this.id = undefined;
                    }
                },
                error: () => {
                    this.notificationService.error('Failed to load configuration');
                },
            });
    }

    private loadReferralConfig() {
        this.dataService
            .query<GetReferralConfigResponse>(GET_REFERRAL_CONFIG)
            .mapSingle(({ referralChannelPoints }) => referralChannelPoints)
            .subscribe({
                next: (config) => {
                    this.referralConfig = config;
                    if (config) {
                        this.referralConfigId = config.id;
                        this.referralForm.patchValue({ points: config.points });
                    } else {
                        this.referralConfigId = undefined;
                    }
                },
                error: () => {
                    this.notificationService.error('Failed to load referral config');
                },
            });
    }

    goToReferralHistory(): void {
        this.router.navigate(['/extensions/referral-rewards']);
    }

    save() {
        if (this.configForm.valid && this.currentChannelId) {
            const input = {
                rupeesPerPoint: +this.configForm.value.rupeesPerPoint,
                pointsPerRupee: +this.configForm.value.pointsPerRupee,
                channelIds: [this.currentChannelId],
            };
            const mutation = this.id
                ? gql`
                    mutation UpdateLoyaltyConfig($id: ID!, $input: LoyaltyPointsConfigInput!) {
                        updateLoyaltyPointsConfig(id: $id, input: $input) {
                            id rupeesPerPoint pointsPerRupee channels { id }
                        }
                    }
                `
                : gql`
                    mutation CreateLoyaltyConfig($input: LoyaltyPointsConfigInput!) {
                        createLoyaltyPointsConfig(input: $input) {
                            id rupeesPerPoint pointsPerRupee channels { id }
                        }
                    }
                `;
            this.dataService
                .mutate<CreateLoyaltyConfigResponse | UpdateLoyaltyConfigResponse>(
                    mutation,
                    this.id ? { id: this.id, input } : { input }
                )
                .subscribe({
                    next: (result: CreateLoyaltyConfigResponse | UpdateLoyaltyConfigResponse) => {
                        const config = 'createLoyaltyPointsConfig' in result
                            ? result.createLoyaltyPointsConfig
                            : result.updateLoyaltyPointsConfig;
                        this.existingConfig = {
                            id: config.id,
                            createdAt: config.createdAt || new Date().toISOString(),
                            updatedAt: config.updatedAt || new Date().toISOString(),
                            rupeesPerPoint: config.rupeesPerPoint,
                            pointsPerRupee: config.pointsPerRupee,
                            channels: config.channels,
                        };
                        this.id = config.id;
                        this.configForm.patchValue({
                            rupeesPerPoint: config.rupeesPerPoint,
                            pointsPerRupee: config.pointsPerRupee,
                        });
                        this.configForm.markAsPristine();
                        this.notificationService.success('Configuration updated');
                    },
                    error: () => {
                        this.notificationService.error('Failed to save configuration');
                    },
                });
        }
    }

    delete() {
        if (this.id) {
            this.dataService
                .mutate<DeleteLoyaltyConfigResponse>(gql`
                    mutation DeleteLoyaltyConfig($id: ID!) {
                        deleteLoyaltyPointsConfig(id: $id)
                    }
                `, { id: this.id })
                .subscribe({
                    next: () => {
                        this.notificationService.success('Configuration deleted');
                        this.existingConfig = null;
                        this.id = undefined;
                        this.configForm.reset();
                    },
                    error: () => {
                        this.notificationService.error('Failed to delete configuration');
                    },
                });
        }
    }

    saveReferral(): void {
        if (!this.referralForm.valid) return;
        const points = +this.referralForm.value.points;
        const mutation = this.referralConfigId
            ? gql`
                mutation UpdateReferralChannelPoints($id: ID!, $input: ReferralChannelPointsInput!) {
                    updateReferralChannelPoints(id: $id, input: $input) {
                        id points channels { id code }
                    }
                }
            `
            : gql`
                mutation CreateReferralChannelPoints($input: ReferralChannelPointsInput!) {
                    createReferralChannelPoints(input: $input) {
                        id points channels { id code }
                    }
                }
            `;
        const variables = this.referralConfigId
            ? { id: this.referralConfigId, input: { points } }
            : { input: { points } };
        this.dataService.mutate<any>(mutation, variables).subscribe({
            next: (result) => {
                const config = result.createReferralChannelPoints || result.updateReferralChannelPoints;
                this.referralConfig = config;
                this.referralConfigId = config.id;
                this.referralForm.patchValue({ points: config.points });
                this.referralForm.markAsPristine();
                this.notificationService.success('Referral points updated');
            },
            error: () => {
                this.notificationService.error('Failed to save referral points');
            },
        });
    }

    deleteReferral(): void {
        if (!this.referralConfigId) return;
        this.dataService
            .mutate<{ deleteReferralChannelPoints: boolean }>(
                gql`
                    mutation DeleteReferralChannelPoints($id: ID!) {
                        deleteReferralChannelPoints(id: $id)
                    }
                `,
                { id: this.referralConfigId },
            )
            .subscribe({
                next: () => {
                    this.notificationService.success('Referral points config deleted');
                    this.referralConfig = null;
                    this.referralConfigId = undefined;
                    this.referralForm.reset();
                },
                error: () => {
                    this.notificationService.error('Failed to delete referral points config');
                },
            });
    }
}

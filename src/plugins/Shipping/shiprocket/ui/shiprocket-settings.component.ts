import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { DataService, NotificationService, SharedModule } from '@vendure/admin-ui/core';
import { take } from 'rxjs/operators';
import gql from 'graphql-tag';

const CONFIG_KEY = 'shiprocket.config';

const GET_CONFIG = gql`
    query GetShiprocketConfig($key: String!) {
        getSettingsStoreValue(key: $key)
    }
`;

const SET_CONFIG = gql`
    mutation SetShiprocketConfig($input: SettingsStoreInput!) {
        setSettingsStoreValue(input: $input) {
            key
            result
            error
        }
    }
`;

interface BoxBracket {
    maxGrams: number;
    length: number;
    breadth: number;
    height: number;
}

interface ShiprocketConfig {
    pickupPincode: string;
    pickupLocationName: string;
    fxRate: number;
    boxBrackets: BoxBracket[];
}

// Mirrors DEFAULT_SHIPROCKET_CONFIG on the server so a never-saved channel shows sane values.
const DEFAULT_CONFIG: ShiprocketConfig = {
    pickupPincode: '',
    pickupLocationName: '',
    fxRate: 1,
    boxBrackets: [{ maxGrams: 2000, length: 20, breadth: 15, height: 10 }],
};

@Component({
    standalone: true,
    imports: [SharedModule],
    selector: 'vdr-shiprocket-settings',
    template: `
        <vdr-page-block>
            <div class="sr-toolbar" *vdrIfPermissions="['UpdateShiprocketSettings', 'SuperAdmin']">
                <span class="sr-dirty">{{ saving ? 'Saving…' : 'Channel-scoped settings' }}</span>
                <button class="btn btn-primary" [disabled]="saving || loading" (click)="save()">Save</button>
            </div>

            <div *ngIf="loading" class="sr-loading">Loading Shiprocket settings…</div>

            <ng-container *ngIf="!loading && config">
                <div class="sr-card">
                    <div class="sr-card-title">Shiprocket account</div>
                    <div class="sr-grid">
                        <label class="sr-field">
                            <span class="sr-label">Pickup pincode</span>
                            <input type="text" [(ngModel)]="config.pickupPincode" placeholder="625018" />
                        </label>
                        <label class="sr-field">
                            <span class="sr-label">Pickup location name</span>
                            <input type="text" [(ngModel)]="config.pickupLocationName" placeholder="warehouse" />
                        </label>
                        <label class="sr-field">
                            <span class="sr-label">FX rate (INR per 1 USD)</span>
                            <input type="number" [(ngModel)]="config.fxRate" placeholder="83" />
                        </label>
                    </div>
                    <p class="sr-hint">
                        Pickup location name must match a pickup address nickname saved in Shiprocket
                        (used when creating orders at fulfillment). The destination country comes from
                        the order's shipping address.
                    </p>
                </div>

                <div class="sr-card">
                    <div class="sr-card-header">
                        <div class="sr-card-title">Box dimensions by weight</div>
                        <button class="btn btn-secondary btn-sm" (click)="addBracket()">+ Add row</button>
                    </div>
                    <table class="sr-table">
                        <thead>
                            <tr>
                                <th>Up to weight (g)</th>
                                <th>Length (cm)</th>
                                <th>Breadth (cm)</th>
                                <th>Height (cm)</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr *ngFor="let b of config.boxBrackets; let i = index">
                                <td><input type="number" [(ngModel)]="b.maxGrams" /></td>
                                <td><input type="number" [(ngModel)]="b.length" /></td>
                                <td><input type="number" [(ngModel)]="b.breadth" /></td>
                                <td><input type="number" [(ngModel)]="b.height" /></td>
                                <td>
                                    <button
                                        *ngIf="config.boxBrackets.length > 1"
                                        class="btn btn-link btn-sm"
                                        (click)="removeBracket(i)">
                                        Remove
                                    </button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                    <p class="sr-hint">
                        A cart uses the first row whose "up to weight" it does not exceed (rows are
                        sorted ascending). Carts heavier than every row fall back to the largest one.
                    </p>
                </div>
            </ng-container>
        </vdr-page-block>
    `,
    styles: [`
        .sr-toolbar {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 0.75rem;
            margin-bottom: 1rem;
        }
        .sr-dirty {
            font-size: 0.75rem;
            color: var(--color-text-300);
        }
        .sr-loading {
            color: var(--color-text-300);
            padding: 1rem 0;
        }
        .sr-card {
            border: 1px solid var(--color-component-border-200);
            border-radius: 6px;
            background: var(--color-component-bg-100);
            padding: 1rem;
            margin-bottom: 1rem;
        }
        .sr-card-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 0.75rem;
        }
        .sr-card-title {
            font-weight: 600;
            color: var(--color-text-800);
            margin-bottom: 0.75rem;
        }
        .sr-card-header .sr-card-title {
            margin-bottom: 0;
        }
        .sr-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 0.75rem;
        }
        .sr-field {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
        }
        .sr-label {
            font-size: 0.7rem;
            color: var(--color-text-500);
            font-weight: 500;
            letter-spacing: 0.03em;
            text-transform: uppercase;
        }
        .sr-field input,
        .sr-table input {
            padding: 0.35rem 0.5rem;
            border: 1px solid var(--color-component-border-300);
            border-radius: 4px;
            background: var(--color-component-bg-100);
            color: var(--color-text-900);
            font-size: 0.85rem;
            width: 100%;
        }
        .sr-table {
            width: 100%;
            border-collapse: collapse;
        }
        .sr-table th {
            text-align: left;
            font-size: 0.7rem;
            font-weight: 500;
            color: var(--color-text-500);
            padding: 0.25rem 0.5rem 0.25rem 0;
        }
        .sr-table td {
            padding: 0.25rem 0.5rem 0.25rem 0;
            border-top: 1px solid var(--color-component-border-200);
        }
        .sr-hint {
            margin-top: 0.75rem;
            font-size: 0.75rem;
            color: var(--color-text-300);
        }
    `],
})
export class ShiprocketSettingsComponent implements OnInit {
    config: ShiprocketConfig | null = null;
    loading = true;
    saving = false;

    constructor(
        private dataService: DataService,
        private notificationService: NotificationService,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit() {
        this.dataService.query(GET_CONFIG, { key: CONFIG_KEY })
            .mapStream((data: any) => data.getSettingsStoreValue)
            .pipe(take(1))
            .subscribe({
                next: stored => {
                    const cfg: ShiprocketConfig = { ...DEFAULT_CONFIG, ...(stored ?? {}) };
                    if (!cfg.boxBrackets?.length) {
                        cfg.boxBrackets = [...DEFAULT_CONFIG.boxBrackets];
                    }
                    this.config = cfg;
                    this.loading = false;
                    this.cdr.markForCheck();
                },
                error: (e: any) => {
                    this.loading = false;
                    this.notificationService.error(e?.message ?? 'Failed to load Shiprocket settings');
                    this.cdr.markForCheck();
                },
            });
    }

    addBracket() {
        this.config?.boxBrackets.push({ maxGrams: 0, length: 0, breadth: 0, height: 0 });
    }

    removeBracket(i: number) {
        this.config?.boxBrackets.splice(i, 1);
    }

    save() {
        if (!this.config) {
            return;
        }
        this.saving = true;
        this.dataService.mutate(SET_CONFIG, { input: { key: CONFIG_KEY, value: this.config } })
            .pipe(take(1))
            .subscribe({
                next: (res: any) => {
                    const r = res.setSettingsStoreValue;
                    if (r?.result === false) {
                        this.notificationService.error(r.error ?? 'Save failed');
                    } else {
                        this.notificationService.success('Shiprocket settings saved');
                    }
                    this.saving = false;
                    this.cdr.markForCheck();
                },
                error: (e: any) => {
                    this.notificationService.error(e?.message ?? 'Save failed');
                    this.saving = false;
                    this.cdr.markForCheck();
                },
            });
    }
}

import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { UntypedFormGroup } from '@angular/forms';
import {
    CustomDetailComponent,
    DataService,
    NotificationService,
    SharedModule,
} from '@vendure/admin-ui/core';
import gql from 'graphql-tag';
import { Observable } from 'rxjs';
import {
    AdminOption,
    CANCEL_ORDER_ALERT_KEY,
    CANCEL_ORDER_DEFAULT_ALERT_KEY,
    DEFAULT_CHANNEL_CODE,
    normalizePhone,
    resolveAlertConfig,
    sanitizeIds,
    sanitizeNumbers,
} from './cancel-order-alerts.helpers';

// Built-in SettingsStore operations. Hand-authored as raw gql because the React dashboard's
// typed graphql() documents are not reusable across the Angular build boundary.
const GET_SETTINGS_STORE_VALUES = gql`
    query GetCancelOrderAlertConfig($keys: [String!]!) {
        getSettingsStoreValues(keys: $keys)
    }
`;

// Which layer this block edits depends on whether the admin is on the default channel.
const GET_ACTIVE_CHANNEL = gql`
    query GetActiveChannelForCancelAlerts {
        activeChannel {
            id
            code
        }
    }
`;

// Candidates for the administrator picker. Those without a phone number are filtered
// client-side so the reason is visible.
const GET_ADMINISTRATORS = gql`
    query CancelOrderAdministrators {
        administrators(options: { take: 200 }) {
            items {
                id
                firstName
                lastName
                emailAddress
                customFields {
                    phoneNumber
                }
            }
        }
    }
`;

const SET_SETTINGS_STORE_VALUES = gql`
    mutation SetCancelOrderAlertConfig($inputs: [SettingsStoreInput!]!) {
        setSettingsStoreValues(inputs: $inputs) {
            key
            result
            error
        }
    }
`;

/**
 * Only ever edits ONE layer: the shared defaults when the admin is on the default channel,
 * that channel's own override otherwise. Each layer is a set of administrators plus a set of
 * ad-hoc numbers; the alert goes to the union of the two.
 */
@Component({
    selector: 'cancel-order-alerts',
    standalone: true,
    imports: [SharedModule],
    template: `
        <vdr-card title="Order Cancellation Alerts">
            <p class="alert-help">
                Who gets the WhatsApp alert when a customer requests an order cancellation. Numbers
                must include the country code (for example 916380774767); a bare 10-digit number is
                prefixed with 91 automatically.
            </p>

            <section class="alert-section">
                <h5 *ngIf="isDefaultChannel">Default recipients</h5>
                <p class="alert-hint" *ngIf="isDefaultChannel">
                    Used by every channel that has no recipients of its own. Switch to another
                    channel to give it a different list.
                </p>

                <h5 *ngIf="!isDefaultChannel">
                    Recipients for the {{ activeChannelCode || 'active' }} channel
                </h5>
                <p class="alert-hint" *ngIf="!isDefaultChannel">
                    Leave both empty to use the default recipients. Those are edited on the Default
                    channel.
                </p>
                <p class="alert-empty" *ngIf="!isDefaultChannel && !usingChannelList()">
                    No override set — this channel uses the default recipients.
                </p>

                <vdr-form-field label="MSG91 sender number" *ngIf="isDefaultChannel">
                    <input
                        type="text"
                        placeholder="919894681385"
                        [value]="defaultHelloNumber"
                        (input)="defaultHelloNumber = $any($event.target).value"
                    />
                </vdr-form-field>
                <p class="alert-hint" *ngIf="isDefaultChannel">
                    The MSG91 "Hello" integrated number the alert is sent from. Shared by all channels.
                </p>
            </section>

            <section class="alert-section">
                <h5>Administrators</h5>
                <p class="alert-hint">
                    Search by name, email or number. Administrators with no phone number saved on
                    their profile are listed but cannot be picked — add one on their Administrator
                    page first. The number is read at send time, so it stays current if they change it.
                </p>

                <div class="chip-row">
                    <span class="chip" *ngFor="let id of editedAdminIds(); trackBy: trackByValue">
                        {{ adminLabel(id) }}
                        <button class="chip-remove" (click)="removeAdmin(id)" title="Remove administrator">
                            <clr-icon shape="times"></clr-icon>
                        </button>
                    </span>
                </div>

                <input
                    class="admin-search"
                    type="search"
                    placeholder="Search by name, email or number…"
                    [value]="adminSearch"
                    (input)="adminSearch = $any($event.target).value"
                />

                <select
                    class="admin-select"
                    [disabled]="availableAdmins().length === 0"
                    (change)="addAdmin($any($event.target).value); $any($event.target).value = ''"
                >
                    <option value="">
                        {{
                            availableAdmins().length === 0
                                ? 'No administrator matches'
                                : 'Add an administrator…'
                        }}
                    </option>
                    <option
                        *ngFor="let admin of availableAdmins()"
                        [value]="admin.id"
                        [disabled]="!admin.phone"
                    >
                        {{ admin.name }} · {{ admin.phone || 'no phone number saved' }}
                    </option>
                </select>
            </section>

            <section class="alert-section">
                <h5>Other numbers</h5>
                <p class="alert-hint">
                    For people who are not administrators — a warehouse line, an on-call number.
                </p>

                <div
                    class="number-row"
                    *ngFor="let number of editedNumbers(); let i = index; trackBy: trackByIndex"
                >
                    <input
                        type="text"
                        placeholder="916380774767"
                        [value]="number"
                        (input)="updateNumber(i, $any($event.target).value)"
                    />
                    <button class="btn btn-sm btn-link" (click)="removeNumber(i)" title="Remove number">
                        <clr-icon shape="trash"></clr-icon>
                    </button>
                </div>
                <button class="btn btn-sm btn-secondary" (click)="addNumber()">
                    <clr-icon shape="plus"></clr-icon>
                    Add number
                </button>

                <p class="alert-warn" *ngIf="redundantNumbers().length > 0">
                    {{ redundantNumbers().join(', ') }} already belongs to a picked administrator, so
                    it is only messaged once. Remove it here and the administrator entry keeps working
                    even if they change their number.
                </p>
            </section>

            <section class="alert-section">
                <h5>A cancellation in {{ activeChannelCode || 'this channel' }} will alert</h5>
                <p class="alert-effective">
                    {{ effectiveNumbers().join(', ') }}
                    <span class="alert-hint">({{ usingChannelList() ? 'channel list' : 'default list' }})</span>
                </p>
            </section>

            <div class="alert-error" *ngIf="isDefaultLayerEmpty()">
                At least one default recipient is required — every channel without its own list
                falls back to this one.
            </div>
            <div class="alert-error" *ngIf="hasInvalidNumber()">
                Some numbers look too short. Enter a 10-digit mobile number or a full number with
                country code.
            </div>

            <div class="save-row">
                <button class="btn btn-primary" [disabled]="!canSave()" (click)="save()">
                    {{ saving ? 'Saving…' : 'Save recipients' }}
                </button>
            </div>
        </vdr-card>
    `,
    styles: [
        `
            .alert-help {
                color: var(--color-grey-500);
                margin-bottom: 12px;
            }
            .alert-section {
                border-top: 1px solid var(--color-component-border-200);
                padding-top: 12px;
                margin-top: 16px;
            }
            .alert-section h5 {
                margin: 0 0 4px;
            }
            .alert-hint {
                color: var(--color-grey-500);
                font-size: 12px;
                margin: 4px 0 8px;
            }
            .chip-row {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-bottom: 8px;
            }
            .chip {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 2px 8px;
                border-radius: 12px;
                background: var(--color-component-bg-200);
                font-size: 12px;
            }
            .chip-remove {
                background: none;
                border: none;
                cursor: pointer;
                color: inherit;
                padding: 0;
            }
            .admin-search {
                width: 100%;
                max-width: 420px;
                margin-bottom: 6px;
            }
            .admin-select {
                width: 100%;
                max-width: 420px;
            }
            .number-row {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-bottom: 6px;
            }
            .alert-empty {
                color: var(--color-grey-500);
                font-style: italic;
                margin-bottom: 8px;
            }
            .alert-warn {
                color: var(--color-warning-600);
                font-size: 12px;
                margin-top: 8px;
            }
            .alert-error {
                color: var(--color-error-500);
                margin-top: 8px;
            }
            .save-row {
                margin-top: 16px;
            }
        `,
    ],
})
export class CancelOrderAlertsComponent implements CustomDetailComponent, OnInit {
    // Required by the CustomDetailComponent contract. This block saves through its own
    // mutation rather than the Global Settings page form, so neither input is read.
    entity$!: Observable<any>;
    detailForm!: UntypedFormGroup;

    defaultHelloNumber = '';
    defaultNumbers: string[] = [];
    defaultAdminIds: string[] = [];
    channelNumbers: string[] = [];
    channelAdminIds: string[] = [];
    adminOptions: AdminOption[] = [];
    adminSearch = '';
    activeChannelCode = '';
    isDefaultChannel = false;
    saving = false;

    constructor(
        private readonly dataService: DataService,
        private readonly notificationService: NotificationService,
        private readonly changeDetector: ChangeDetectorRef,
    ) {}

    ngOnInit(): void {
        this.dataService
            .query<{ activeChannel: { code: string } }>(GET_ACTIVE_CHANNEL)
            .single$.subscribe(result => {
                this.isDefaultChannel = result.activeChannel.code === DEFAULT_CHANNEL_CODE;
                this.activeChannelCode = this.isDefaultChannel
                    ? 'Default channel'
                    : result.activeChannel.code;
                this.changeDetector.markForCheck();
            });

        this.dataService
            .query<{ administrators: { items: any[] } }>(GET_ADMINISTRATORS)
            .single$.subscribe(result => {
                // Only admins with a phone number on file can be messaged, so the rest are
                // not offered as options.
                this.adminOptions = (result.administrators?.items ?? []).map(item => ({
                    id: String(item.id),
                    name: `${item.firstName} ${item.lastName}`.trim() || item.emailAddress,
                    email: String(item.emailAddress ?? ''),
                    phone: normalizePhone(String(item.customFields?.phoneNumber ?? '')),
                }));
                this.changeDetector.markForCheck();
            });

        this.dataService
            .query<{ getSettingsStoreValues: Record<string, any> }>(GET_SETTINGS_STORE_VALUES, {
                keys: [CANCEL_ORDER_ALERT_KEY, CANCEL_ORDER_DEFAULT_ALERT_KEY],
            })
            .single$.subscribe(result => {
                const values = result.getSettingsStoreValues ?? {};
                // The default layer is seeded from the resolver so a never-configured install
                // shows the numbers that are actually being messaged today.
                const seeded = resolveAlertConfig({ global: values[CANCEL_ORDER_DEFAULT_ALERT_KEY] });
                this.defaultHelloNumber = seeded.helloNumber;
                this.defaultNumbers = seeded.supportNumbers;
                this.defaultAdminIds = seeded.adminIds;
                // The channel layer is NOT seeded — empty has to stay empty, or "use the
                // defaults" becomes impossible to express.
                const stored = values[CANCEL_ORDER_ALERT_KEY];
                this.channelNumbers = sanitizeNumbers(stored?.supportNumbers);
                this.channelAdminIds = sanitizeIds(stored?.adminIds);
                this.changeDetector.markForCheck();
            });
    }

    trackByIndex(index: number): number {
        return index;
    }

    trackByValue(index: number, value: string): string {
        return value;
    }

    /** The one layer this page is editing, decided by the active channel. */
    editedNumbers(): string[] {
        return this.isDefaultChannel ? this.defaultNumbers : this.channelNumbers;
    }

    editedAdminIds(): string[] {
        return this.isDefaultChannel ? this.defaultAdminIds : this.channelAdminIds;
    }

    /** Not-yet-selected admins, narrowed by the search box (name, email or number). */
    availableAdmins(): AdminOption[] {
        const selected = this.editedAdminIds();
        const term = this.adminSearch.trim().toLowerCase();
        return this.adminOptions
            .filter(option => !selected.includes(option.id))
            .filter(
                option =>
                    term.length === 0 ||
                    `${option.name} ${option.email} ${option.phone}`.toLowerCase().includes(term),
            );
    }

    adminLabel(id: string): string {
        const admin = this.adminOptions.find(option => option.id === id);
        if (!admin) {
            return `Unknown admin #${id}`;
        }
        return `${admin.name} · ${admin.phone || 'no phone number'}`;
    }

    addAdmin(id: string): void {
        if (!id) {
            return;
        }
        // Phone-less admins are rendered disabled, but guard anyway — selecting one would
        // store an id that resolves to no recipient at send time.
        const admin = this.adminOptions.find(option => option.id === id);
        if (!admin?.phone) {
            return;
        }
        this.assignAdminIds([...this.editedAdminIds(), id]);
    }

    removeAdmin(id: string): void {
        this.assignAdminIds(this.editedAdminIds().filter(x => x !== id));
    }

    updateNumber(index: number, value: string): void {
        this.assignNumbers(this.editedNumbers().map((number, i) => (i === index ? value : number)));
    }

    addNumber(): void {
        this.assignNumbers([...this.editedNumbers(), '']);
    }

    removeNumber(index: number): void {
        this.assignNumbers(this.editedNumbers().filter((_, i) => i !== index));
    }

    /**
     * Hand-typed numbers that already belong to a picked administrator. Harmless — the send
     * path de-dupes — but an admin who later changes their phone leaves a stale copy behind
     * here, so it is worth flagging rather than silently accepting.
     */
    redundantNumbers(): string[] {
        const adminPhones = new Set(
            this.editedAdminIds()
                .map(id => this.adminOptions.find(option => option.id === id)?.phone ?? '')
                .filter(phone => phone.length > 0),
        );
        return sanitizeNumbers(this.editedNumbers()).filter(number => adminPhones.has(number));
    }

    hasInvalidNumber(): boolean {
        return this.editedNumbers().some(
            number => number.trim().length > 0 && normalizePhone(number).length < 11,
        );
    }

    /**
     * The shared layer is the last stop before the seed constants, so emptying it on the
     * default channel is a mistake rather than a fallback.
     */
    isDefaultLayerEmpty(): boolean {
        return (
            this.isDefaultChannel &&
            sanitizeNumbers(this.defaultNumbers).length === 0 &&
            sanitizeIds(this.defaultAdminIds).length === 0
        );
    }

    usingChannelList(): boolean {
        return (
            sanitizeNumbers(this.channelNumbers).length > 0 ||
            sanitizeIds(this.channelAdminIds).length > 0
        );
    }

    /** Exactly what the backend will do with the values currently in the form. */
    effectiveNumbers(): string[] {
        const resolved = resolveAlertConfig({
            channel: { supportNumbers: this.channelNumbers, adminIds: this.channelAdminIds },
            global: {
                helloNumber: this.defaultHelloNumber,
                supportNumbers: this.defaultNumbers,
                adminIds: this.defaultAdminIds,
            },
        });
        const fromAdmins = resolved.adminIds
            .map(id => this.adminOptions.find(option => option.id === id)?.phone ?? '')
            .filter(phone => phone.length > 0);
        return Array.from(new Set([...fromAdmins, ...resolved.supportNumbers]));
    }

    canSave(): boolean {
        return !this.hasInvalidNumber() && !this.isDefaultLayerEmpty() && !this.saving;
    }

    save(): void {
        this.saving = true;
        // Only the layer the admin can actually see is written back, so editing one channel
        // can never clobber the other layer.
        const inputs = this.isDefaultChannel
            ? [
                  {
                      key: CANCEL_ORDER_DEFAULT_ALERT_KEY,
                      value: {
                          helloNumber: normalizePhone(this.defaultHelloNumber),
                          supportNumbers: sanitizeNumbers(this.defaultNumbers),
                          adminIds: sanitizeIds(this.defaultAdminIds),
                      },
                  },
              ]
            : [
                  {
                      key: CANCEL_ORDER_ALERT_KEY,
                      value: {
                          supportNumbers: sanitizeNumbers(this.channelNumbers),
                          adminIds: sanitizeIds(this.channelAdminIds),
                      },
                  },
              ];

        this.dataService
            .mutate<{ setSettingsStoreValues: Array<{ result: boolean; error?: string }> }>(
                SET_SETTINGS_STORE_VALUES,
                { inputs },
            )
            .subscribe({
                next: result => {
                    this.saving = false;
                    // setSettingsStoreValues reports failure per key rather than throwing.
                    const failed = result.setSettingsStoreValues.find(r => r.result === false);
                    if (failed) {
                        this.notificationService.error(failed.error ?? 'Could not save recipients');
                    } else {
                        this.notificationService.success('Cancellation alert recipients saved');
                        this.assignNumbers(sanitizeNumbers(this.editedNumbers()));
                    }
                    this.changeDetector.markForCheck();
                },
                error: () => {
                    this.saving = false;
                    this.notificationService.error('Could not save recipients');
                    this.changeDetector.markForCheck();
                },
            });
    }

    private assignNumbers(numbers: string[]): void {
        if (this.isDefaultChannel) {
            this.defaultNumbers = numbers;
        } else {
            this.channelNumbers = numbers;
        }
    }

    private assignAdminIds(ids: string[]): void {
        if (this.isDefaultChannel) {
            this.defaultAdminIds = ids;
        } else {
            this.channelAdminIds = ids;
        }
    }
}

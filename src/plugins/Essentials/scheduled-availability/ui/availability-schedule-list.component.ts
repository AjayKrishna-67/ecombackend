import { ChangeDetectionStrategy, ChangeDetectorRef, Component, inject } from '@angular/core';
import { FormControl } from '@angular/forms';
import { SharedModule, TypedBaseListComponent } from '@vendure/admin-ui/core';
import gql from 'graphql-tag';
import {
    ChipColor,
    describeAction,
    describeLifecycle,
    describeRowName,
    describeCron,
    describeSchedule,
    findScheduleWarning,
    formatChannelCode,
    runStatusColor,
    runStatusLabel,
    ScheduleLike,
} from './format';

export const GET_AVAILABILITY_SCHEDULES = gql`
    query GetAvailabilitySchedulesList($options: AvailabilityScheduleListOptions, $allChannels: Boolean) {
        availabilitySchedules(options: $options, allChannels: $allChannels) {
            items {
                id
                createdAt
                updatedAt
                kind
                mode
                isEnabled
                label
                timezone
                targetType
                targetId
                targetName
                runAt
                action
                disableCron
                enableCron
                sendCron
                reportType
                reportSellerId
                reportSellerName
                reportChannels {
                    id
                    code
                }
                recipients
                dateRangeMode
                channel {
                    id
                    code
                }
                latestRun {
                    id
                    status
                    action
                    dueAt
                    executedAt
                    lastError
                    note
                    attempts
                }
                nextRun {
                    id
                    status
                    dueAt
                }
            }
            totalItems
        }
    }
`;

/**
 * Read-only list of availability and report schedules.
 *
 * Read-only deliberately. Every mutation on this API is scoped to the active
 * channel via `findOne`, so once the all-channels toggle is on, a row may
 * belong to a channel this screen cannot act on. Offering a pause button that
 * fails for half the rows is worse than offering none -- edits stay in the
 * Dashboard, which is always channel-scoped and therefore always consistent.
 */
@Component({
    selector: 'availability-schedule-list',
    template: `
        <vdr-page-block>
            <vdr-action-bar>
                <vdr-ab-left>
                    <div class="scope-toggle">
                        <clr-checkbox-wrapper>
                            <input
                                type="checkbox"
                                clrCheckbox
                                [formControl]="allChannelsControl"
                                id="all-channels"
                            />
                            <label for="all-channels">Show schedules from all my channels</label>
                        </clr-checkbox-wrapper>
                        <div class="muted small">
                            <ng-container *ngIf="allChannelsControl.value; else scopedHint">
                                Read-only across channels. To edit a rule, switch to its channel.
                            </ng-container>
                            <ng-template #scopedHint>
                                Showing <strong>{{ activeChannelLabel }}</strong> only — schedules on
                                other channels are hidden.
                            </ng-template>
                        </div>
                    </div>
                </vdr-ab-left>
            </vdr-action-bar>
        </vdr-page-block>
        <vdr-data-table-2
            id="availability-schedule-list"
            [items]="items$ | async"
            [itemsPerPage]="itemsPerPage$ | async"
            [totalItems]="totalItems$ | async"
            [currentPage]="currentPage$ | async"
            [filters]="filters"
            (pageChange)="setPageNumber($event)"
            (itemsPerPageChange)="setItemsPerPage($event)"
        >
            <vdr-dt2-search
                [searchTermControl]="searchTermControl"
                searchTermPlaceholder="Filter by label"
            />
            <vdr-dt2-column heading="ID" [hiddenByDefault]="true" [sort]="sorts.get('id')">
                <ng-template let-row="item">{{ row.id }}</ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Channel" [optional]="false">
                <ng-template let-row="item">
                    <vdr-chip>{{ channelCode(row.channel) }}</vdr-chip>
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Name" [optional]="false" [sort]="sorts.get('label')">
                <ng-template let-row="item">
                    <div class="stack">
                        <div class="row-name">{{ rowName(row) }}</div>
                        <div *ngIf="warning(row) as text" class="warn small" [title]="text">
                            <clr-icon shape="exclamation-triangle" size="12"></clr-icon>
                            {{ text }}
                        </div>
                    </div>
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Kind">
                <ng-template let-row="item">
                    <vdr-chip [colorType]="row.kind === 'REPORT' ? 'warning' : undefined">
                        {{ row.kind === 'REPORT' ? 'Report' : 'Availability' }}
                    </vdr-chip>
                </ng-template>
            </vdr-dt2-column>
            <!--
                [expand] makes this the only column that soaks up leftover width
                (th.expand { width: 100% }), so the fixed-content columns around it
                stop being squeezed by this long sentence.
            -->
            <vdr-dt2-column heading="What it does" [optional]="false" [expand]="true">
                <ng-template let-row="item">
                    <span class="muted summary">{{ summary(row) }}</span>
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="State" [optional]="false">
                <ng-template let-row="item">
                    <vdr-chip [colorType]="stateColor(row)" [title]="stateHint(row)">
                        {{ stateLabel(row) }}
                    </vdr-chip>
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Last run">
                <ng-template let-row="item">
                    <div class="stack">
                        <ng-container *ngIf="row.latestRun; else neverRan">
                            <vdr-chip [colorType]="lastRunColor(row)">{{ lastRunLabel(row) }}</vdr-chip>
                            <div class="muted small">
                                {{ row.latestRun.executedAt | localeDate: 'short' }}
                            </div>
                            <div *ngIf="row.latestRun.lastError" class="warn small">
                                {{ row.latestRun.lastError }}
                            </div>
                        </ng-container>
                        <ng-template #neverRan><span class="muted">Never</span></ng-template>
                    </div>
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Next run" [hiddenByDefault]="true">
                <ng-template let-row="item">
                    {{ row.nextRun ? (row.nextRun.dueAt | localeDate: 'short') : '—' }}
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Send cron" [hiddenByDefault]="true">
                <ng-template let-row="item">
                    <div class="stack">
                        <ng-container *ngIf="row.sendCron; else noCron">
                            <code>{{ row.sendCron }}</code>
                            <div class="muted small">{{ cron(row.sendCron) }}</div>
                        </ng-container>
                        <ng-template #noCron><span class="muted">—</span></ng-template>
                    </div>
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Report type" [hiddenByDefault]="true">
                <ng-template let-row="item">
                    {{ row.reportType === 'PURCHASE_LIST' ? 'Purchase list' : '—' }}
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Reports on" [hiddenByDefault]="true">
                <ng-template let-row="item">
                    <div class="chips">
                        <ng-container *ngIf="row.reportSellerName; else noneCell">
                            <vdr-chip>{{ row.reportSellerName }}</vdr-chip>
                            <span class="muted">{{ brandChannelSummary(row) }}</span>
                        </ng-container>
                        <ng-template #noneCell><span class="muted">—</span></ng-template>
                    </div>
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Recipients" [hiddenByDefault]="true">
                <ng-template let-row="item">
                    <div class="stack">
                        <ng-container *ngIf="row.recipients?.length; else noRecipients">
                            <div class="muted small" *ngFor="let number of row.recipients">
                                {{ number }}
                            </div>
                        </ng-container>
                        <ng-template #noRecipients>
                            <span class="warn">None</span>
                        </ng-template>
                    </div>
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Covers" [hiddenByDefault]="true">
                <ng-template let-row="item">
                    {{ row.dateRangeMode === 'YESTERDAY' ? 'Yesterday' : row.dateRangeMode === 'TODAY' ? 'Today' : '—' }}
                </ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Timezone" [hiddenByDefault]="true" [sort]="sorts.get('timezone')">
                <ng-template let-row="item">{{ row.timezone }}</ng-template>
            </vdr-dt2-column>
            <vdr-dt2-column heading="Created" [hiddenByDefault]="true" [sort]="sorts.get('createdAt')">
                <ng-template let-row="item">{{ row.createdAt | localeDate: 'short' }}</ng-template>
            </vdr-dt2-column>
        </vdr-data-table-2>
    `,
    styles: [
        `
            .scope-toggle {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            /*
             * vdr-data-table-2 wraps every cell in .cell-content, which is
             * "display: flex; align-items: center" -- so a template with more than
             * one child element lays those children out SIDE BY SIDE and, because
             * flex items default to min-width:auto, lets them spill over the
             * neighbouring column. Any multi-element cell therefore gets exactly
             * one child: this stack, which does the vertical layout itself.
             */
            .stack {
                display: flex;
                flex-direction: column;
                align-items: flex-start;
                gap: 2px;
                min-width: 0;
                line-height: 1.35;
                padding: 2px 0;
            }
            .chips {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 2px;
                min-width: 0;
            }
            .summary {
                display: block;
                min-width: 0;
                line-height: 1.35;
                white-space: normal;
            }
            .stack > *,
            .summary {
                overflow-wrap: anywhere;
            }
            .row-name {
                font-weight: 600;
            }
            .muted {
                color: var(--color-text-300);
            }
            .small {
                font-size: 12px;
            }
            .warn {
                color: var(--color-warning-500);
                font-size: 12px;
                display: block;
                max-width: 320px;
            }
            code {
                font-size: 12px;
            }
        `,
    ],
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: true,
    imports: [SharedModule],
})
export class AvailabilityScheduleListComponent extends TypedBaseListComponent<
    typeof GET_AVAILABILITY_SCHEDULES,
    'availabilitySchedules'
> {
    readonly dataTableListId = 'availability-schedule-list';

    /**
     * Widens the query to every channel the admin holds SuperAdmin on.
     *
     * Off by default so the screen matches the Dashboard until asked otherwise;
     * a list that silently spans channels would make "why is this rule here?" an
     * unanswerable question on first sight.
     */
    readonly allChannelsControl = new FormControl(false);

    activeChannelLabel = 'this channel';

    // `dataService` is inherited from TypedBaseListComponent as protected --
    // redeclaring it privately here is a TS2415 "incorrectly extends" error,
    // not a shadow.
    private readonly changeDetector = inject(ChangeDetectorRef);

    readonly filters = this.createFilterCollection()
        .addFilter({
            name: 'kind',
            type: {
                kind: 'select',
                options: [
                    { value: 'AVAILABILITY', label: 'Availability' },
                    { value: 'REPORT', label: 'Report' },
                ],
            },
            label: 'Kind',
            filterField: 'kind',
        })
        .addFilter({
            name: 'isEnabled',
            type: { kind: 'boolean' },
            label: 'Enabled',
            filterField: 'isEnabled',
        })
        .addFilter({
            name: 'mode',
            type: {
                kind: 'select',
                options: [
                    { value: 'ONE_OFF', label: 'One-off' },
                    { value: 'RECURRING', label: 'Recurring' },
                ],
            },
            label: 'Mode',
            filterField: 'mode',
        })
        .connectToRoute(this.route);

    readonly sorts = this.createSortCollection()
        .defaultSort('createdAt', 'DESC')
        .addSort({ name: 'id' })
        .addSort({ name: 'createdAt' })
        .addSort({ name: 'updatedAt' })
        .addSort({ name: 'label' })
        .addSort({ name: 'runAt' })
        .addSort({ name: 'timezone' })
        .connectToRoute(this.route);

    constructor() {
        super();
        super.configure({
            document: GET_AVAILABILITY_SCHEDULES as any,
            getItems: (data: any) => data.availabilitySchedules,
            setVariables: ((skip: number, take: number) => {
                const term = (this.searchTermControl.value ?? '').trim();
                // Label-only, because AvailabilityScheduleFilterParameter exposes
                // no id and no targetName field. Widening this means widening the
                // API first -- a client-side name match would silently only
                // search the current page.
                const termFilter: Record<string, unknown> = term
                    ? { label: { contains: term } }
                    : {};
                return {
                    allChannels: this.allChannelsControl.value === true,
                    options: {
                        skip,
                        take,
                        filter: {
                            ...termFilter,
                            ...(this.filters.createFilterInput() as Record<string, unknown>),
                        },
                        sort: this.sorts.createSortInput(),
                    },
                };
            }) as any,
            refreshListOnChanges: [
                this.filters.valueChanges,
                this.sorts.valueChanges,
                this.searchTermControl.valueChanges,
                this.allChannelsControl.valueChanges,
            ],
        });
        this.loadChannelCodes();
    }

    /** `channel` is a relation, so its code arrives with the row. */
    channelCode(channel: { code?: string } | null | undefined): string {
        return formatChannelCode(channel?.code);
    }

    /**
     * The cities a brand currently resolves to, named rather than counted.
     *
     * Resolved server-side per read, so this is what the NEXT run will cover --
     * not what the last one did. A count alone ("6 channels") would hide the one
     * question an admin asks here: is my city in this report?
     */
    brandChannelSummary(row: ScheduleLike): string {
        const channels = (row as any).reportChannels as Array<{ code: string }> | null | undefined;
        if (!channels?.length) {
            return 'no channels';
        }
        return channels.map(channel => formatChannelCode(channel.code)).join(', ');
    }

    rowName(row: ScheduleLike): string {
        return describeRowName(row);
    }

    summary(row: ScheduleLike): string {
        return describeSchedule(row);
    }

    warning(row: ScheduleLike): string | null {
        return findScheduleWarning(row);
    }

    stateLabel(row: ScheduleLike): string {
        return describeLifecycle(row).label;
    }

    stateColor(row: ScheduleLike): ChipColor {
        return describeLifecycle(row).color;
    }

    stateHint(row: ScheduleLike): string {
        return describeLifecycle(row).hint;
    }

    lastRunLabel(row: ScheduleLike): string {
        return `${runStatusLabel(row.latestRun?.status)}${
            row.latestRun?.action ? ` — ${describeAction(row.latestRun.action as string)}` : ''
        }`;
    }

    lastRunColor(row: ScheduleLike): ChipColor {
        return runStatusColor(row.latestRun?.status);
    }

    cron(pattern: string | null | undefined): string {
        return describeCron(pattern);
    }

    /**
     * Names the active channel for the hint.
     *
     * Sourced from `userStatus`, not from a `channels` query: its `channels`
     * array is the session's own grants -- the exact client-side mirror of the
     * `channelPermissions` the server intersects on.
     */
    private loadChannelCodes(): void {
        this.dataService.client.userStatus().single$.subscribe(data => {
            const status = data?.userStatus;
            const active = (status?.channels ?? []).find(
                channel => String(channel.id) === String(status?.activeChannelId),
            );
            this.activeChannelLabel = formatChannelCode(active?.code);
            this.changeDetector.markForCheck();
        });
    }
}

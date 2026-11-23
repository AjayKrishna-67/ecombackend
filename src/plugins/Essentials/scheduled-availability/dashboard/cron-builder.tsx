import { Button, Input, Label, Switch } from '@vendure/dashboard';
import React from 'react';
import { describeCron } from './format';
import { LabelledSelect } from './labelled-select';

/**
 * Builds the two cron patterns without anyone typing cron.
 *
 * Restricted on purpose to daily / weekly / monthly at a chosen time, which
 * covers every real use of this feature (close overnight, close on Sundays,
 * close on the 1st). Anything more exotic is still reachable through the
 * "advanced" escape hatch, which shows the raw field -- so the simple UI never
 * becomes a ceiling.
 */

export type CronFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface CronParts {
    frequency: CronFrequency;
    time: string;
    /**
     * Day-of-week numbers, 0 = Sunday. Several are allowed: cron's day-of-week
     * field takes a comma list, so "close on Wednesday and Friday nights" is one
     * pattern rather than two rules the admin has to keep in step by hand.
     */
    weekdays: string[];
    monthDay: string;
}

export const DEFAULT_CRON_PARTS: CronParts = {
    frequency: 'DAILY',
    time: '22:00',
    weekdays: ['5'],
    monthDay: '1',
};

const WEEKDAYS: Array<{ value: string; short: string; label: string }> = [
    { value: '0', short: 'Sun', label: 'Sunday' },
    { value: '1', short: 'Mon', label: 'Monday' },
    { value: '2', short: 'Tue', label: 'Tuesday' },
    { value: '3', short: 'Wed', label: 'Wednesday' },
    { value: '4', short: 'Thu', label: 'Thursday' },
    { value: '5', short: 'Fri', label: 'Friday' },
    { value: '6', short: 'Sat', label: 'Saturday' },
];

/**
 * Sorted, de-duplicated, so `5,1` and `1,5,5` produce the same pattern.
 *
 * De-duplicated by indexOf rather than a Set: this project's dashboard tsconfig
 * targets below ES2015, where spreading a Set needs downlevelIteration.
 */
function normaliseWeekdays(weekdays: string[]): string[] {
    return weekdays
        .filter((day, index, all) => all.indexOf(day) === index)
        .sort((a, b) => Number(a) - Number(b));
}

/**
 * Composes a 5-field pattern. Field order: minute hour day-of-month month day-of-week.
 *
 * Returns an empty string for a weekly pattern with no days chosen. That is a
 * genuinely incomplete rule, and emitting `0 22 * * ` -- a pattern cron cannot
 * parse -- would push the failure all the way to the worker at 10pm.
 */
export function buildCron(parts: CronParts): string {
    const [hour, minute] = parts.time.split(':');
    const safeMinute = Number(minute ?? 0);
    const safeHour = Number(hour ?? 0);
    if (parts.frequency === 'WEEKLY') {
        const days = normaliseWeekdays(parts.weekdays);
        if (!days.length) {
            return '';
        }
        return `${safeMinute} ${safeHour} * * ${days.join(',')}`;
    }
    if (parts.frequency === 'MONTHLY') {
        return `${safeMinute} ${safeHour} ${parts.monthDay} * *`;
    }
    return `${safeMinute} ${safeHour} * * *`;
}

/**
 * Best-effort reverse of `buildCron`, so editing an existing rule opens in the
 * simple UI when the pattern is one this builder could have produced. Anything
 * else returns null and the caller falls back to the raw field -- a lossy guess
 * would silently rewrite a pattern the admin carefully hand-tuned.
 */
export function parseCron(pattern: string | null): CronParts | null {
    if (!pattern) {
        return null;
    }
    const fields = pattern.trim().split(/\s+/);
    if (fields.length !== 5) {
        return null;
    }
    const [minute, hour, monthDay, month, weekday] = fields;
    if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || month !== '*') {
        return null;
    }
    const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    if (monthDay === '*' && weekday === '*') {
        return { ...DEFAULT_CRON_PARTS, frequency: 'DAILY', time };
    }
    // A comma list, not just a single digit: patterns this builder now produces
    // must round-trip, or every edit of a multi-day rule would drop to the raw
    // cron field.
    if (monthDay === '*' && /^[0-6](,[0-6])*$/.test(weekday)) {
        return {
            ...DEFAULT_CRON_PARTS,
            frequency: 'WEEKLY',
            time,
            weekdays: normaliseWeekdays(weekday.split(',')),
        };
    }
    if (/^\d+$/.test(monthDay) && weekday === '*') {
        return { ...DEFAULT_CRON_PARTS, frequency: 'MONTHLY', time, monthDay };
    }
    return null;
}

export function CronBuilder({
    title,
    enabled,
    onEnabledChange,
    parts,
    onPartsChange,
    advanced,
    rawPattern,
    onRawPatternChange,
    onToggleAdvanced,
}: Readonly<{
    title: string;
    enabled: boolean;
    onEnabledChange: (enabled: boolean) => void;
    parts: CronParts;
    onPartsChange: (parts: CronParts) => void;
    advanced: boolean;
    rawPattern: string;
    onRawPatternChange: (pattern: string) => void;
    onToggleAdvanced: () => void;
}>) {
    const pattern = advanced ? rawPattern : buildCron(parts);
    const sentence = enabled ? describeCron(pattern) : null;
    const noDaysChosen = !advanced && parts.frequency === 'WEEKLY' && !parts.weekdays.length;

    const toggleWeekday = (value: string) => {
        const next = parts.weekdays.includes(value)
            ? parts.weekdays.filter(day => day !== value)
            : [...parts.weekdays, value];
        onPartsChange({ ...parts, weekdays: normaliseWeekdays(next) });
    };

    return (
        <div className="rounded-md border p-3">
            <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">{title}</Label>
                <Switch checked={enabled} onCheckedChange={onEnabledChange} />
            </div>

            {enabled && (
                <div className="mt-3 space-y-3">
                    {advanced ? (
                        <Input
                            placeholder="0 22 * * *"
                            value={rawPattern}
                            onChange={event => onRawPatternChange(event.target.value)}
                        />
                    ) : (
                        <>
                            <div className="flex flex-wrap items-end gap-2">
                                <LabelledSelect
                                    className="min-w-32"
                                    value={parts.frequency}
                                    onChange={frequency =>
                                        onPartsChange({
                                            ...parts,
                                            frequency: frequency as CronFrequency,
                                        })
                                    }
                                    options={[
                                        { value: 'DAILY', label: 'Every day' },
                                        { value: 'WEEKLY', label: 'On chosen days' },
                                        { value: 'MONTHLY', label: 'Every month' },
                                    ]}
                                />
                                {parts.frequency === 'MONTHLY' && (
                                    <Input
                                        type="number"
                                        min={1}
                                        max={28}
                                        className="w-20"
                                        value={parts.monthDay}
                                        onChange={event =>
                                            onPartsChange({
                                                ...parts,
                                                monthDay: event.target.value,
                                            })
                                        }
                                    />
                                )}
                                <Input
                                    type="time"
                                    className="w-32"
                                    value={parts.time}
                                    onChange={event =>
                                        onPartsChange({ ...parts, time: event.target.value })
                                    }
                                />
                            </div>

                            {parts.frequency === 'WEEKLY' && (
                                <div className="space-y-2">
                                    <div className="flex flex-wrap gap-1">
                                        {WEEKDAYS.map(day => {
                                            const selected = parts.weekdays.includes(day.value);
                                            return (
                                                <Button
                                                    key={day.value}
                                                    type="button"
                                                    size="sm"
                                                    variant={selected ? 'default' : 'outline'}
                                                    aria-pressed={selected}
                                                    aria-label={day.label}
                                                    className="w-14"
                                                    onClick={() => toggleWeekday(day.value)}
                                                >
                                                    {day.short}
                                                </Button>
                                            );
                                        })}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-3">
                                        <span className="text-muted-foreground text-xs">
                                            {parts.weekdays.length === 0
                                                ? 'No days chosen'
                                                : `${parts.weekdays.length} ${
                                                      parts.weekdays.length === 1 ? 'day' : 'days'
                                                  } a week`}
                                        </span>
                                        <PresetButton
                                            label="Weekdays"
                                            onClick={() =>
                                                onPartsChange({
                                                    ...parts,
                                                    weekdays: ['1', '2', '3', '4', '5'],
                                                })
                                            }
                                        />
                                        <PresetButton
                                            label="Weekend"
                                            onClick={() =>
                                                onPartsChange({ ...parts, weekdays: ['0', '6'] })
                                            }
                                        />
                                        <PresetButton
                                            label="Clear"
                                            onClick={() => onPartsChange({ ...parts, weekdays: [] })}
                                        />
                                    </div>
                                </div>
                            )}
                        </>
                    )}

                    <div className="flex items-center justify-between gap-2">
                        <p
                            className={
                                noDaysChosen
                                    ? 'text-destructive text-xs'
                                    : 'text-muted-foreground text-xs'
                            }
                        >
                            {noDaysChosen
                                ? 'Pick at least one day, or switch to Every day.'
                                : (sentence ?? 'Enter a valid pattern')}
                        </p>
                        <Button variant="link" size="sm" onClick={onToggleAdvanced}>
                            {advanced ? 'Use the simple picker' : 'Advanced (cron)'}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}

function PresetButton({ label, onClick }: Readonly<{ label: string; onClick: () => void }>) {
    return (
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onClick}>
            {label}
        </Button>
    );
}

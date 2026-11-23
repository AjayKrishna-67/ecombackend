import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@vendure/dashboard';
import React, { useMemo } from 'react';

export interface SelectOption {
    value: string;
    label: string;
}

/**
 * A Select whose trigger shows the *label*, not the value.
 *
 * The dashboard is built on Base UI, not Radix, and Base UI's `Select.Value`
 * renders the raw value unless it is given both an `items` map and a render
 * function. Skipping that is why the first version of this form showed "1" for
 * a channel, "ONE_OFF" for a mode and "DISABLE" for an action -- and why the
 * target-type field looked fine, since there the value happens to equal the
 * label. Wrapping it once means no call site can get it wrong again.
 */
export function LabelledSelect({
    value,
    onChange,
    options,
    placeholder,
    className,
    disabled,
}: Readonly<{
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    placeholder?: string;
    className?: string;
    disabled?: boolean;
}>) {
    const items = useMemo(
        () => Object.fromEntries(options.map(option => [option.value, option.label])),
        [options],
    );
    return (
        <Select
            items={items}
            value={value}
            disabled={disabled}
            onValueChange={next => next && onChange(next)}
        >
            <SelectTrigger className={className}>
                <SelectValue placeholder={placeholder}>
                    {(selected: string) => items[selected] ?? placeholder}
                </SelectValue>
            </SelectTrigger>
            <SelectContent>
                {options.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                        {option.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

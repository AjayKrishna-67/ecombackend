import {
    api,
    DashboardFormComponent,
    Input,
    Label,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    useChannel,
} from '@vendure/dashboard';
import { useQuery } from '@tanstack/react-query';
import React, { useEffect } from 'react';
import { useFormContext } from 'react-hook-form';
import { getChannelPostalCodesDocument, PostalCode } from './queries';

/**
 * Combined Pincode + Area control rendered in place of the Address `area` custom field.
 *
 * The core `postalCode` input lives in a Dialog without a PageBlock context, so it cannot
 * be overridden directly. Instead this component (rendered inside the same react-hook-form
 * provider) reaches the sibling `postalCode` field via useFormContext().
 *
 * Mode is decided from the active channel's postal codes:
 *  - "anywhere" mode (an isAnywhere record, or no codes configured) -> free text only.
 *  - specific pincodes -> a pincode dropdown (writes `postalCode`) + an area dropdown.
 */
export const PincodeAreaInput: DashboardFormComponent = ({ value, onChange, disabled }) => {
    const form = useFormContext();
    const { activeChannel } = useChannel();
    const channelId = activeChannel?.id;

    const selectedPincode = (form?.watch('postalCode') as string) || '';
    const areaValue = (value as string) || '';

    const { data } = useQuery({
        queryKey: ['channel-postal-codes', channelId],
        queryFn: () => api.query(getChannelPostalCodesDocument),
    });
    const items: PostalCode[] = (data as any)?.postalCodes?.items ?? [];
    const isAnywhereMode = items.some(pc => pc.isAnywhere) || items.length === 0;
    const specific = items.filter(pc => !pc.isAnywhere);

    const current = specific.find(pc => pc.code === selectedPincode);
    const areas = (current?.areas ?? []).filter(a => a.enabled);

    // Clear a stale area when the pincode changes to one that no longer offers it.
    useEffect(() => {
        if (isAnywhereMode) {
            return;
        }
        if (areaValue && areas.length > 0 && !areas.some(a => a.name === areaValue)) {
            onChange?.('');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedPincode]);

    const setPincode = (code: string) => {
        form?.setValue('postalCode', code, { shouldDirty: true, shouldValidate: true });
    };

    if (isAnywhereMode) {
        // Pincode handled by the core text input; this field is a free-text landmark.
        return (
            <Input
                value={areaValue}
                disabled={disabled}
                placeholder="Area / landmark (optional)"
                onChange={e => onChange?.(e.target.value)}
            />
        );
    }

    return (
        <div className="flex flex-col gap-3">
            {/* Specific mode: hide the core read-only Postal Code text field; this
                dropdown becomes the postal code control. :has() is supported in Chromium. */}
            <style>{`[data-slot="field"]:has(#field-postalCode){display:none !important;}`}</style>
            <div className="flex flex-col gap-1.5">
                <Label>Postal Code</Label>
                <Select value={selectedPincode} disabled={disabled} onValueChange={setPincode}>
                    <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select a postal code" />
                    </SelectTrigger>
                    <SelectContent>
                        {specific.map(pc => (
                            <SelectItem key={pc.id} value={pc.code}>
                                {pc.code}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            <div className="flex flex-col gap-1.5">
                <Label>Area / Landmark</Label>
                {areas.length > 0 ? (
                    <Select
                        value={areaValue}
                        disabled={disabled || !selectedPincode}
                        onValueChange={v => onChange?.(v)}
                    >
                        <SelectTrigger className="w-full">
                            <SelectValue placeholder={selectedPincode ? 'Select an area' : 'Select a pincode first'} />
                        </SelectTrigger>
                        <SelectContent>
                            {areas.map(a => (
                                <SelectItem key={a.id} value={a.name}>
                                    {a.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                ) : (
                    <Input
                        value={areaValue}
                        disabled={disabled}
                        placeholder="Area / landmark (optional)"
                        onChange={e => onChange?.(e.target.value)}
                    />
                )}
            </div>
        </div>
    );
};

import { useQuery } from '@tanstack/react-query';
import {
    api,
    Button,
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    Popover,
    PopoverContent,
    PopoverTrigger,
    VendureImage,
} from '@vendure/dashboard';
import { Check, ChevronsUpDown } from 'lucide-react';
import React, { useState } from 'react';
import {
    availabilityTargetSearchDocument,
    AvailabilityTargetType,
    TargetOption,
} from './queries';

interface TargetComboboxProps {
    targetType: AvailabilityTargetType;
    channelId: string;
    value: TargetOption | null;
    onChange: (option: TargetOption) => void;
}

/**
 * Type-ahead picker over products or collections, scoped to the channel the
 * schedule will belong to.
 *
 * Two things it prevents. Resolving a name to an ID stops a mistyped digit from
 * silently targeting the wrong entity. Searching inside `channelId` -- rather
 * than the channel the admin is browsing -- stops the subtler failure: picking a
 * collection that exists in Default but not in Madurai produced a rule that
 * saved fine and then failed on every occurrence with "entity not found".
 */
export function TargetCombobox({ targetType, channelId, value, onChange }: TargetComboboxProps) {
    const [open, setOpen] = useState(false);
    const [term, setTerm] = useState('');
    const canSearch = !!channelId && term.trim().length >= 2;

    const { data, isFetching } = useQuery({
        queryKey: ['availability-target-search', targetType, channelId, term],
        enabled: canSearch,
        queryFn: () =>
            api.query(availabilityTargetSearchDocument, {
                targetType,
                channelId,
                term: term.trim(),
            }),
    });

    const options: TargetOption[] = ((data as any)?.availabilityTargetSearch ?? []).map(
        (option: any) => ({
            id: String(option.id),
            name: option.name,
            asset: option.asset ?? null,
        }),
    );

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    role="combobox"
                    disabled={!channelId}
                    className="w-full justify-between"
                >
                    {value ? value.name : `Select a ${targetType.toLowerCase()}...`}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[360px] p-0">
                <Command shouldFilter={false}>
                    <CommandInput
                        placeholder={`Search ${targetType.toLowerCase()}s in this channel...`}
                        value={term}
                        onValueChange={setTerm}
                    />
                    <CommandList>
                        <CommandEmpty>
                            {!channelId
                                ? 'Choose a channel first.'
                                : term.trim().length < 2
                                  ? 'Type at least 2 characters.'
                                  : isFetching
                                    ? 'Searching...'
                                    : 'No matches in this channel.'}
                        </CommandEmpty>
                        <CommandGroup>
                            {options.map(option => (
                                <CommandItem
                                    key={option.id}
                                    value={option.id}
                                    onSelect={() => {
                                        onChange(option);
                                        setOpen(false);
                                    }}
                                >
                                    <Check
                                        className={
                                            value?.id === option.id
                                                ? 'mr-2 h-4 w-4 opacity-100'
                                                : 'mr-2 h-4 w-4 opacity-0'
                                        }
                                    />
                                    {option.asset && (
                                        <VendureImage
                                            asset={option.asset}
                                            preset="tiny"
                                            className="mr-2 h-6 w-6 rounded object-cover"
                                        />
                                    )}
                                    {option.name}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}

import {
    api,
    Badge,
    Button,
    Command,
    CommandEmpty,
    CommandInput,
    CommandItem,
    CommandList,
    DEFAULT_CHANNEL_CODE,
    Input,
    Label,
    Popover,
    PopoverContent,
    PopoverTrigger,
    Spinner,
    useChannel,
    usePermissions,
} from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronsUpDown, Plus, Trash2, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CANCEL_ORDER_ALERT_KEY, CANCEL_ORDER_DEFAULT_ALERT_KEY } from '../constants';
import { normalizePhone } from '../functions/normalize-phone';
import { resolveAlertConfig, sanitizeIds, sanitizeNumbers } from '../functions/resolve-alert-config';
import { administratorsDocument, getAlertConfigDocument, setAlertConfigDocument } from './queries';

const KEYS = [CANCEL_ORDER_ALERT_KEY, CANCEL_ORDER_DEFAULT_ALERT_KEY];

interface AdminOption {
    id: string;
    name: string;
    email: string;
    /** Empty when the admin has no phoneNumber custom field saved — they cannot be messaged. */
    phone: string;
}

/**
 * Editable list of ad-hoc phone numbers. An empty list is meaningful here (on a non-default
 * channel it means "not set, fall through to the defaults"), so this renders no rows when empty.
 */
function NumberList(props: {
    numbers: string[];
    disabled: boolean;
    onChange: (numbers: string[]) => void;
}) {
    const { numbers, disabled, onChange } = props;
    return (
        <div className="space-y-2">
            {numbers.map((number, index) => (
                <div key={index} className="flex items-center gap-2">
                    <Input
                        value={number}
                        disabled={disabled}
                        onChange={event =>
                            onChange(numbers.map((n, i) => (i === index ? event.target.value : n)))
                        }
                        placeholder="916380774767"
                    />
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={disabled}
                        onClick={() => onChange(numbers.filter((_, i) => i !== index))}
                        aria-label="Remove number"
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
            ))}
            <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => onChange([...numbers, ''])}
            >
                <Plus className="h-4 w-4 mr-1" /> Add number
            </Button>
        </div>
    );
}

/**
 * Searchable administrator picker. Stores ids, not numbers — an admin who updates their phone
 * keeps receiving alerts with no edit here. Every administrator is listed, including Super
 * Admin; those with no phone number on file are shown but not selectable, so the reason is
 * visible rather than the name silently missing from the list.
 */
function AdminPicker(props: {
    selectedIds: string[];
    options: AdminOption[];
    disabled: boolean;
    onChange: (ids: string[]) => void;
}) {
    const { selectedIds, options, disabled, onChange } = props;
    const [open, setOpen] = useState(false);
    const byId = new Map(options.map(option => [option.id, option]));
    const available = options.filter(option => !selectedIds.includes(option.id));

    return (
        <div className="space-y-2">
            {selectedIds.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {selectedIds.map(id => {
                        const admin = byId.get(id);
                        return (
                            <Badge key={id} variant={admin?.phone ? 'secondary' : 'destructive'}>
                                {admin
                                    ? `${admin.name} · ${admin.phone || 'no phone number'}`
                                    : `Unknown admin #${id}`}
                                {!disabled && (
                                    <button
                                        type="button"
                                        className="ml-1"
                                        onClick={() => onChange(selectedIds.filter(x => x !== id))}
                                        aria-label="Remove administrator"
                                    >
                                        <X className="h-3 w-3" />
                                    </button>
                                )}
                            </Badge>
                        );
                    })}
                </div>
            )}
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={disabled || available.length === 0}
                        className="w-full justify-between font-normal"
                    >
                        {available.length === 0
                            ? 'All administrators added'
                            : 'Search administrators…'}
                        <ChevronsUpDown className="h-4 w-4 opacity-50" />
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                    <Command>
                        {/* Matches name, email and number, so "9789" or "muthu" both find the row. */}
                        <CommandInput placeholder="Search by name, email or number…" />
                        <CommandList>
                            <CommandEmpty>No administrator matches.</CommandEmpty>
                            {available.map(option => (
                                <CommandItem
                                    key={option.id}
                                    value={`${option.name} ${option.email} ${option.phone}`}
                                    disabled={!option.phone}
                                    onSelect={() => {
                                        if (!option.phone) return;
                                        onChange([...selectedIds, option.id]);
                                        setOpen(false);
                                    }}
                                >
                                    <div className="flex flex-col">
                                        <span>{option.name}</span>
                                        <span className="text-xs text-muted-foreground">
                                            {option.phone || 'No phone number saved on their profile'}
                                        </span>
                                    </div>
                                </CommandItem>
                            ))}
                        </CommandList>
                    </Command>
                </PopoverContent>
            </Popover>
        </div>
    );
}

/**
 * Only ever edits ONE layer: the shared defaults when the admin is on the default channel,
 * that channel's own override otherwise. Each layer is a set of administrators plus a set of
 * ad-hoc numbers; the alert goes to the union of the two.
 */
export function CancelOrderAlertsBlock() {
    const queryClient = useQueryClient();
    const { hasPermissions } = usePermissions();
    const { activeChannel } = useChannel();
    const canEdit = hasPermissions(['UpdateGlobalSettings']);

    const isDefaultChannel = activeChannel?.code === DEFAULT_CHANNEL_CODE;
    const channelLabel = isDefaultChannel ? 'Default channel' : (activeChannel?.code ?? 'this channel');

    // Shared default layer — editable on the default channel only.
    const [defaultHelloNumber, setDefaultHelloNumber] = useState('');
    const [defaultNumbers, setDefaultNumbers] = useState<string[]>([]);
    const [defaultAdminIds, setDefaultAdminIds] = useState<string[]>([]);
    // Channel override layer — empty means "use the defaults".
    const [channelNumbers, setChannelNumbers] = useState<string[]>([]);
    const [channelAdminIds, setChannelAdminIds] = useState<string[]>([]);

    // The channel key is channel-scoped, so the channel id belongs in the cache key — otherwise
    // switching channels would show the previous channel's numbers from cache.
    const queryKey = ['cancel-order-alert-config', activeChannel?.id];

    const configQuery = useQuery({
        queryKey,
        queryFn: () => api.query(getAlertConfigDocument, { keys: KEYS }),
    });
    const adminsQuery = useQuery({
        queryKey: ['cancel-order-administrators'],
        queryFn: () => api.query(administratorsDocument),
    });

    // Every administrator is listed, Super Admin included. Those with no phone number are
    // rendered disabled rather than hidden — a missing name reads as a bug, a greyed row
    // with "no phone number saved" tells you exactly what to fix.
    const adminOptions: AdminOption[] = ((adminsQuery.data as any)?.administrators?.items ?? []).map(
        (item: any) => ({
            id: String(item.id),
            name: `${item.firstName} ${item.lastName}`.trim() || item.emailAddress,
            email: String(item.emailAddress ?? ''),
            phone: normalizePhone(String(item.customFields?.phoneNumber ?? '')),
        }),
    );
    const adminPhoneById = new Map(adminOptions.map(option => [option.id, option.phone]));

    useEffect(() => {
        if (!configQuery.data) {
            return;
        }
        const values = (configQuery.data as any)?.getSettingsStoreValues ?? {};
        const stored = values[CANCEL_ORDER_ALERT_KEY] ?? null;
        const storedDefault = values[CANCEL_ORDER_DEFAULT_ALERT_KEY] ?? null;
        // The default layer is seeded from the resolver so a never-configured install shows the
        // numbers that are actually being messaged today rather than an empty box.
        const seededDefault = resolveAlertConfig({ global: storedDefault });
        setDefaultHelloNumber(seededDefault.helloNumber);
        setDefaultNumbers(seededDefault.supportNumbers);
        setDefaultAdminIds(seededDefault.adminIds);
        // The channel layer is NOT seeded — empty has to stay empty, or "use the defaults"
        // becomes impossible to express.
        setChannelNumbers(sanitizeNumbers(stored?.supportNumbers));
        setChannelAdminIds(sanitizeIds(stored?.adminIds));
    }, [configQuery.data]);

    const saveMutation = useMutation({
        mutationFn: () =>
            api.mutate(setAlertConfigDocument, {
                // Only the layer the admin can actually see is written back, so editing one
                // channel can never clobber the other layer.
                inputs: isDefaultChannel
                    ? [
                          {
                              key: CANCEL_ORDER_DEFAULT_ALERT_KEY,
                              value: {
                                  helloNumber: normalizePhone(defaultHelloNumber),
                                  supportNumbers: sanitizeNumbers(defaultNumbers),
                                  adminIds: sanitizeIds(defaultAdminIds),
                              },
                          },
                      ]
                    : [
                          {
                              key: CANCEL_ORDER_ALERT_KEY,
                              value: {
                                  supportNumbers: sanitizeNumbers(channelNumbers),
                                  adminIds: sanitizeIds(channelAdminIds),
                              },
                          },
                      ],
            }),
        onSuccess: (result: any) => {
            // setSettingsStoreValues reports failure per key in the payload rather than throwing.
            const failed = (result?.setSettingsStoreValues ?? []).find((r: any) => r?.result === false);
            if (failed) {
                toast.error(failed.error ?? 'Could not save cancellation alert recipients');
                return;
            }
            toast.success('Cancellation alert recipients saved');
            void queryClient.invalidateQueries({ queryKey });
        },
        onError: (error: any) =>
            toast.error(error?.message ?? 'Could not save cancellation alert recipients'),
    });

    const editedNumbers = isDefaultChannel ? defaultNumbers : channelNumbers;
    const editedAdminIds = isDefaultChannel ? defaultAdminIds : channelAdminIds;
    const hasInvalidNumber = editedNumbers.some(
        number => number.trim().length > 0 && normalizePhone(number).length < 11,
    );
    // The shared layer is the last stop before the seed constants, so emptying it on the
    // default channel is a mistake rather than a fallback.
    const defaultLayerEmpty =
        isDefaultChannel &&
        sanitizeNumbers(defaultNumbers).length === 0 &&
        sanitizeIds(defaultAdminIds).length === 0;
    const canSave = canEdit && !hasInvalidNumber && !defaultLayerEmpty && !saveMutation.isPending;

    // Exactly what the backend will do with the values currently in the form: the winning
    // layer's admins resolved to phone numbers, unioned with its ad-hoc numbers.
    const resolved = resolveAlertConfig({
        channel: { supportNumbers: channelNumbers, adminIds: channelAdminIds },
        global: {
            helloNumber: defaultHelloNumber,
            supportNumbers: defaultNumbers,
            adminIds: defaultAdminIds,
        },
    });
    const effectiveNumbers = Array.from(
        new Set([
            ...resolved.adminIds.map(id => adminPhoneById.get(id) ?? '').filter(Boolean),
            ...resolved.supportNumbers,
        ]),
    );
    const usingChannelList =
        sanitizeNumbers(channelNumbers).length > 0 || sanitizeIds(channelAdminIds).length > 0;

    // A number typed by hand that already belongs to a picked administrator. Harmless — the
    // send path de-dupes — but it means an admin who changes their phone leaves a stale copy
    // behind here, so it is worth flagging rather than silently accepting.
    const adminPhonesInLayer = new Set(
        editedAdminIds.map(id => adminPhoneById.get(id) ?? '').filter(Boolean),
    );
    const redundantNumbers = sanitizeNumbers(editedNumbers).filter(number =>
        adminPhonesInLayer.has(number),
    );

    if (configQuery.isLoading || adminsQuery.isLoading) {
        return <Spinner />;
    }

    const editor = (
        <>
            <div className="space-y-2">
                <Label>Administrators</Label>
                <p className="text-xs text-muted-foreground">
                    Search by name, email or number. Administrators with no phone number saved on
                    their profile are listed but cannot be picked — add one on their Administrator
                    page first. The number is read at send time, so it stays current if they change it.
                </p>
                <AdminPicker
                    selectedIds={editedAdminIds}
                    options={adminOptions}
                    disabled={!canEdit}
                    onChange={isDefaultChannel ? setDefaultAdminIds : setChannelAdminIds}
                />
            </div>
            <div className="space-y-2">
                <Label>Other numbers</Label>
                <p className="text-xs text-muted-foreground">
                    For people who are not administrators — a warehouse line, an on-call number.
                </p>
                <NumberList
                    numbers={editedNumbers}
                    disabled={!canEdit}
                    onChange={isDefaultChannel ? setDefaultNumbers : setChannelNumbers}
                />
                {redundantNumbers.length > 0 && (
                    <p className="text-xs text-amber-600 dark:text-amber-500">
                        {redundantNumbers.join(', ')} already belongs to a picked administrator, so
                        it is only messaged once. Remove it here and the administrator entry keeps
                        working even if they change their number.
                    </p>
                )}
            </div>
        </>
    );

    return (
        <div className="space-y-6">
            <p className="text-sm text-muted-foreground">
                Who gets the WhatsApp alert when a customer requests an order cancellation. Numbers
                must include the country code (for example 916380774767); a bare 10-digit number is
                prefixed with 91 automatically.
            </p>

            {isDefaultChannel ? (
                <div className="space-y-4">
                    <div>
                        <Label className="text-base">Default recipients</Label>
                        <p className="text-xs text-muted-foreground mt-1">
                            Used by every channel that has no recipients of its own. Switch to
                            another channel to give it a different list.
                        </p>
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="cancel-order-hello-number">MSG91 sender number</Label>
                        <Input
                            id="cancel-order-hello-number"
                            value={defaultHelloNumber}
                            disabled={!canEdit}
                            onChange={event => setDefaultHelloNumber(event.target.value)}
                            placeholder="919894681385"
                        />
                        <p className="text-xs text-muted-foreground">
                            The MSG91 &quot;Hello&quot; integrated number the alert is sent from.
                            Shared by all channels.
                        </p>
                    </div>
                    {editor}
                    {defaultLayerEmpty && (
                        <p className="text-sm text-destructive">
                            At least one default recipient is required — every channel without its
                            own list falls back to this one.
                        </p>
                    )}
                </div>
            ) : (
                <div className="space-y-4">
                    <div>
                        <Label className="text-base">
                            Recipients for the <strong>{channelLabel}</strong> channel
                        </Label>
                        <p className="text-xs text-muted-foreground mt-1">
                            Leave both empty to use the default recipients. Those are edited on the
                            Default channel.
                        </p>
                    </div>
                    {!usingChannelList && (
                        <p className="text-sm text-muted-foreground italic">
                            No override set — this channel uses the default recipients.
                        </p>
                    )}
                    {editor}
                </div>
            )}

            <div className="border-t pt-4 space-y-1">
                <Label className="text-base">
                    A cancellation in <strong>{channelLabel}</strong> will alert
                </Label>
                <p className="text-sm">
                    {effectiveNumbers.join(', ')}{' '}
                    <span className="text-muted-foreground">
                        ({usingChannelList ? 'channel list' : 'default list'})
                    </span>
                </p>
            </div>

            {hasInvalidNumber && (
                <p className="text-sm text-destructive">
                    Some numbers look too short. Enter a 10-digit mobile number or a full number with
                    country code.
                </p>
            )}

            <Button type="button" disabled={!canSave} onClick={() => saveMutation.mutate()}>
                {saveMutation.isPending ? 'Saving…' : 'Save recipients'}
            </Button>
        </div>
    );
}

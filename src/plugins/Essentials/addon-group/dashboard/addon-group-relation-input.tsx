import { api, Badge, DashboardFormComponent, Input } from '@vendure/dashboard';
import { useQuery } from '@tanstack/react-query';
import { Search, Trash2 } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AddonGroupSummaryDto, getAddonGroupSummariesDocument } from './queries';

/**
 * Custom-field input for `ProductVariant.customFields.addonGroups` (a `list: true`
 * relation). Rendered in place of the default relation control because the plugin
 * declares `ui: { component: 'addon-group-relation-input' }`.
 *
 * Contract: `value` is the relation array the form engine holds — elements may be
 * full entity objects or `{ id }` refs. We normalise to id strings for display and
 * write back `[{ id }]` (the shape the backend relation resolver already consumes,
 * matching the previous Angular input).
 */
const toIdList = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value
        .map(v => (v == null ? null : typeof v === 'object' ? (v as any).id : v))
        .filter((v): v is string | number => v != null)
        .map(String);
};

export const AddonGroupRelationInput: DashboardFormComponent = ({ value, onChange, disabled }) => {
    const selectedIds = useMemo(() => toIdList(value), [value]);

    const [term, setTerm] = useState('');
    const [debounced, setDebounced] = useState('');
    const [showResults, setShowResults] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const t = setTimeout(() => setDebounced(term.trim()), 250);
        return () => clearTimeout(t);
    }, [term]);

    // Close the results dropdown on outside click.
    useEffect(() => {
        const onDocClick = (e: MouseEvent) => {
            if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
                setShowResults(false);
            }
        };
        document.addEventListener('click', onDocClick);
        return () => document.removeEventListener('click', onDocClick);
    }, []);

    // Currently-assigned groups, fetched by id for display.
    const { data: assignedData } = useQuery({
        queryKey: ['addon-relation-assigned', selectedIds.join(',')],
        queryFn: () =>
            api.query(getAddonGroupSummariesDocument, {
                options: { take: selectedIds.length, filter: { id: { in: selectedIds } } },
            }),
        enabled: selectedIds.length > 0,
    });
    const assigned: AddonGroupSummaryDto[] = (assignedData as any)?.addonGroups?.items ?? [];

    // Search results for the dropdown.
    const { data: searchData } = useQuery({
        queryKey: ['addon-relation-search', debounced],
        queryFn: () =>
            api.query(getAddonGroupSummariesDocument, {
                options: { take: 10, filter: { name: { contains: debounced } } },
            }),
        enabled: debounced.length > 0,
    });
    const results: AddonGroupSummaryDto[] = (searchData as any)?.addonGroups?.items ?? [];

    const commit = (ids: string[]) => onChange(ids.map(id => ({ id })));

    const assign = (group: AddonGroupSummaryDto) => {
        if (disabled || selectedIds.includes(group.id)) return;
        commit([...selectedIds, group.id]);
        setTerm('');
        setDebounced('');
        setShowResults(false);
    };

    const remove = (id: string) => {
        if (disabled) return;
        commit(selectedIds.filter(x => x !== id));
    };

    return (
        <div className="w-full text-sm" ref={wrapperRef}>
            <div className="relative mb-2">
                <div className="relative">
                    <Search className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
                    <Input
                        className="pl-8"
                        placeholder="Type to search addon groups…"
                        value={term}
                        disabled={disabled}
                        onChange={e => {
                            setTerm(e.target.value);
                            setShowResults(true);
                        }}
                        onFocus={() => term && setShowResults(true)}
                    />
                </div>
                {showResults && debounced.length > 0 && (
                    <div className="bg-popover absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border shadow-md">
                        {results.length === 0 ? (
                            <div className="text-muted-foreground p-3 text-center text-xs">No groups found</div>
                        ) : (
                            results.map(g => {
                                const isAssigned = selectedIds.includes(g.id);
                                return (
                                    <button
                                        key={g.id}
                                        type="button"
                                        disabled={isAssigned}
                                        onClick={() => assign(g)}
                                        className={`hover:bg-muted flex w-full items-center justify-between gap-2 border-b px-3 py-2 text-left last:border-b-0 ${
                                            isAssigned ? 'cursor-not-allowed opacity-40' : ''
                                        }`}
                                    >
                                        <span className="flex items-center gap-2">
                                            <strong className="font-medium">{g.name}</strong>
                                            <Badge variant={g.selectionType === 'CHECKBOX' ? 'secondary' : 'outline'}>
                                                {g.selectionType === 'CHECKBOX' ? 'Checkbox' : 'Quantity'}
                                            </Badge>
                                            {g.isRequired && (
                                                <Badge variant="destructive" className="text-xs">
                                                    Required
                                                </Badge>
                                            )}
                                        </span>
                                        <span className="text-muted-foreground text-xs">
                                            {isAssigned ? 'Already assigned' : `${g.items.length} item${g.items.length === 1 ? '' : 's'}`}
                                        </span>
                                    </button>
                                );
                            })
                        )}
                    </div>
                )}
            </div>

            {selectedIds.length === 0 ? (
                <div className="text-muted-foreground rounded-md border border-dashed p-4 text-center text-xs">
                    No addon groups assigned. Use the search above to assign groups.
                </div>
            ) : (
                <div className="divide-border overflow-hidden rounded-md border">
                    {selectedIds.map(id => {
                        const g = assigned.find(a => a.id === id);
                        return (
                            <div key={id} className="flex items-center justify-between gap-2 border-b px-3 py-2 last:border-b-0">
                                <span className="flex items-center gap-2">
                                    <strong className="font-medium">{g?.name ?? `#${id}`}</strong>
                                    {g && (
                                        <>
                                            <Badge variant={g.selectionType === 'CHECKBOX' ? 'secondary' : 'outline'}>
                                                {g.selectionType === 'CHECKBOX' ? 'Checkbox' : 'Quantity'}
                                            </Badge>
                                            {g.isRequired && (
                                                <Badge variant="destructive" className="text-xs">
                                                    Required
                                                </Badge>
                                            )}
                                            <span className="text-muted-foreground text-xs">
                                                {g.items.length} item{g.items.length === 1 ? '' : 's'}
                                            </span>
                                        </>
                                    )}
                                </span>
                                {!disabled && (
                                    <button
                                        type="button"
                                        aria-label={`Remove ${g?.name ?? id}`}
                                        className="hover:bg-destructive/20 hover:text-destructive text-muted-foreground rounded-sm p-1.5"
                                        onClick={() => remove(id)}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

// Tell the form engine this input manages a list value (not a single relation).
AddonGroupRelationInput.metadata = { isListInput: true, fullWidth: true };

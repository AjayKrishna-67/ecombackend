import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Badge, Input, PageContextValue, Spinner, usePermissions } from '@vendure/dashboard';
import { Plus, Tag as TagIcon, X } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { toast } from 'sonner';
import {
    findOrCreateTagDocument,
    productTagsDocument,
    setProductTagsDocument,
    setVariantTagsDocument,
    TagDto,
    tagSuggestionsDocument,
    variantTagsDocument,
} from './queries';

type EntityType = 'product' | 'variant';

/**
 * Free-form tag chip input for the product / variant detail right rail.
 * Backend TagService.normalize is canonical; this UI only trims + dedupes on
 * screen and uses the id returned by findOrCreateTag.
 */
export function TagsBlock({ context, entityType }: { context: PageContextValue; entityType: EntityType }) {
    const id = context.entity?.id ? String(context.entity.id) : undefined;
    const queryClient = useQueryClient();
    const inputRef = useRef<HTMLInputElement>(null);
    const { hasPermissions } = usePermissions();
    const canAssign = hasPermissions(['UpdateCatalog']); // attach/detach tags = updating the product
    const canCreate = hasPermissions(['CreateCatalog']); // mint a brand-new tag

    const tagsKey = [`${entityType}-tags`, id];
    const tagsQuery = useQuery({
        queryKey: tagsKey,
        queryFn: () =>
            entityType === 'product'
                ? api.query(productTagsDocument, { productId: id! })
                : api.query(variantTagsDocument, { variantId: id! }),
        enabled: !!id,
    });
    const tags: TagDto[] =
        (tagsQuery.data as any)?.[entityType === 'product' ? 'productTags' : 'variantTags'] ?? [];

    const [input, setInput] = useState('');
    const [open, setOpen] = useState(false);
    const [highlight, setHighlight] = useState(0);

    const suggestQuery = useQuery({
        queryKey: ['tag-suggestions', input],
        queryFn: () => api.query(tagSuggestionsDocument, { term: input }),
        enabled: open,
    });
    const rawSuggestions: TagDto[] = (suggestQuery.data as any)?.tagSuggestions ?? [];
    const suggestions = rawSuggestions.filter(s => !tags.some(t => t.id === s.id));
    const trimmed = input.trim();
    const exactExists =
        !!trimmed && rawSuggestions.some(s => s.key === trimmed.toLowerCase());
    const showCreate =
        canCreate && !!trimmed && !exactExists && !tags.some(t => t.key === trimmed.toLowerCase());

    const setTags = useMutation({
        mutationFn: (tagIds: string[]) =>
            entityType === 'product'
                ? api.mutate(setProductTagsDocument, { productId: id!, tagIds })
                : api.mutate(setVariantTagsDocument, { variantId: id!, tagIds }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: tagsKey }),
        onError: (e: Error) => toast.error(`Couldn't update tags: ${e?.message ?? 'error'}`),
    });

    async function addByValue(value: string) {
        const v = value.trim();
        if (!v) return;
        if (tags.some(t => t.key === v.toLowerCase())) {
            setInput('');
            return;
        }
        try {
            const res = await api.mutate(findOrCreateTagDocument, { value: v });
            const tag = (res as any)?.findOrCreateTag as TagDto;
            if (!tag || tags.some(t => t.id === tag.id)) {
                setInput('');
                return;
            }
            await setTags.mutateAsync([...tags.map(t => t.id), tag.id]);
        } catch (e: any) {
            toast.error(`Couldn't add tag: ${e?.message ?? 'error'}`);
            return;
        }
        setInput('');
        setHighlight(0);
        inputRef.current?.focus(); // keep focus for fast multi-tag entry
    }

    function addSuggestion(s: TagDto) {
        if (tags.some(t => t.id === s.id)) return;
        setTags.mutate([...tags.map(t => t.id), s.id]);
        setInput('');
        setOpen(false);
        inputRef.current?.focus();
    }

    function removeTag(tagId: string) {
        setTags.mutate(tags.filter(t => t.id !== tagId).map(t => t.id));
    }

    function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        const optionCount = suggestions.length + (showCreate ? 1 : 0);
        if (e.key === 'Enter') {
            e.preventDefault();
            if (showCreate && highlight >= suggestions.length) {
                addByValue(trimmed);
            } else if (suggestions[highlight]) {
                addSuggestion(suggestions[highlight]);
            } else if (trimmed && canCreate) {
                addByValue(trimmed);
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setHighlight(h => Math.min(h + 1, Math.max(optionCount - 1, 0)));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight(h => Math.max(h - 1, 0));
        } else if (e.key === 'Escape') {
            setOpen(false);
        } else if (e.key === 'Backspace' && !input && tags.length) {
            removeTag(tags[tags.length - 1].id);
        }
    }

    if (!id) return null;
    const busy = setTags.isPending;

    return (
        <div className="space-y-2">
            <div
                className="border-input bg-background flex flex-wrap items-center gap-1.5 rounded-md border p-2"
                role="group"
                aria-label="Tags"
            >
                {tags.map(tag => (
                    <Badge
                        key={tag.id}
                        variant="secondary"
                        className={`gap-1 ${canAssign ? 'pr-1' : 'px-2.5'}`}
                    >
                        {tag.value}
                        {canAssign && (
                            <button
                                type="button"
                                aria-label={`Remove ${tag.value}`}
                                className="hover:bg-muted-foreground/20 ml-0.5 rounded-sm p-0.5"
                                disabled={busy}
                                onClick={() => removeTag(tag.id)}
                            >
                                <X className="h-3 w-3" />
                            </button>
                        )}
                    </Badge>
                ))}
                {!canAssign && !tags.length && (
                    <span className="text-muted-foreground px-1 text-sm">No tags</span>
                )}
                {canAssign && (
                <div className="relative min-w-[8rem] flex-1">
                    <Input
                        ref={inputRef}
                        value={input}
                        placeholder={tags.length ? 'Add tag…' : 'Add tags'}
                        className="h-7 border-0 px-1 shadow-none focus-visible:ring-0"
                        role="combobox"
                        aria-expanded={open}
                        aria-autocomplete="list"
                        disabled={busy}
                        onChange={e => {
                            setInput(e.target.value);
                            setOpen(true);
                            setHighlight(0);
                        }}
                        onFocus={() => setOpen(true)}
                        onBlur={() => setTimeout(() => setOpen(false), 150)}
                        onKeyDown={onKeyDown}
                    />
                    {open && (trimmed || suggestions.length > 0) && (
                        <ul
                            role="listbox"
                            className="bg-popover text-popover-foreground absolute z-50 mt-1 max-h-56 w-full min-w-[12rem] overflow-auto rounded-md border p-1 shadow-md"
                        >
                            {suggestQuery.isLoading && (
                                <li className="text-muted-foreground flex items-center gap-2 px-2 py-1.5 text-sm">
                                    <Spinner className="h-3 w-3" /> Searching…
                                </li>
                            )}
                            {suggestions.map((s, i) => (
                                <li
                                    key={s.id}
                                    role="option"
                                    aria-selected={highlight === i}
                                    className={`cursor-pointer rounded-sm px-2 py-1.5 text-sm ${
                                        highlight === i ? 'bg-accent text-accent-foreground' : ''
                                    }`}
                                    onMouseDown={e => {
                                        e.preventDefault();
                                        addSuggestion(s);
                                    }}
                                    onMouseEnter={() => setHighlight(i)}
                                >
                                    {s.value}
                                </li>
                            ))}
                            {showCreate && (
                                <li
                                    role="option"
                                    aria-selected={highlight >= suggestions.length}
                                    className={`flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-1.5 text-sm ${
                                        highlight >= suggestions.length ? 'bg-accent text-accent-foreground' : ''
                                    }`}
                                    onMouseDown={e => {
                                        e.preventDefault();
                                        addByValue(trimmed);
                                    }}
                                    onMouseEnter={() => setHighlight(suggestions.length)}
                                >
                                    <Plus className="h-3.5 w-3.5" />
                                    Create &ldquo;{trimmed}&rdquo;
                                </li>
                            )}
                            {!suggestQuery.isLoading && !suggestions.length && !showCreate && (
                                <li className="text-muted-foreground px-2 py-1.5 text-sm">No tags</li>
                            )}
                        </ul>
                    )}
                </div>
                )}
            </div>
            {canAssign && !tags.length && (
                <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                    <TagIcon className="h-3 w-3" />
                    Type a label and press Enter. Tags are internal and shared across all channels.
                </p>
            )}
        </div>
    );
}

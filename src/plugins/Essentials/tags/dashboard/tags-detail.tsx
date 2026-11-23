import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { api, Badge, Card, CardContent, Page, PageTitle, Spinner } from '@vendure/dashboard';
import { Box, ChevronRight, Package } from 'lucide-react';
import React from 'react';
import { catalogTagsDocument, tagProductsDocument, tagVariantsDocument } from './queries';

interface ProductRow {
    id: string;
    name: string;
}
interface VariantRow {
    id: string;
    name: string;
    sku: string;
    product: { id: string };
}

/**
 * Tag detail (Settings → Tags → a tag). Lists the products and variants the
 * tag is assigned to, each linking to its detail page — mirrors the customer
 * group members view.
 */
export function TagsDetailPage() {
    const params = useParams({ strict: false }) as { id?: string };
    const tagId = params.id ?? '';

    const tagsQuery = useQuery({
        queryKey: ['catalog-tags'],
        queryFn: () => api.query(catalogTagsDocument, {}),
    });
    const tag = ((tagsQuery.data as any)?.catalogTags ?? []).find((t: any) => `${t.id}` === `${tagId}`);

    const productsQuery = useQuery({
        queryKey: ['tag-products', tagId],
        queryFn: () => api.query(tagProductsDocument, { tagId }),
        enabled: !!tagId,
    });
    const variantsQuery = useQuery({
        queryKey: ['tag-variants', tagId],
        queryFn: () => api.query(tagVariantsDocument, { tagId }),
        enabled: !!tagId,
    });

    const products: ProductRow[] = (productsQuery.data as any)?.tagProducts ?? [];
    const variants: VariantRow[] = (variantsQuery.data as any)?.tagVariants ?? [];
    const loading = productsQuery.isLoading || variantsQuery.isLoading;

    return (
        <Page pageId="tag-detail">
            <PageTitle>{tag ? `Tag: ${tag.value}` : 'Tag'}</PageTitle>

            <Card>
                <CardContent className="space-y-6 pt-6">
                    {loading ? (
                        <div className="flex justify-center p-8">
                            <Spinner />
                        </div>
                    ) : (
                        <>
                            <section className="space-y-2">
                                <div className="flex items-center gap-2">
                                    <Package className="text-muted-foreground h-4 w-4" />
                                    <h3 className="text-sm font-semibold">
                                        Products ({products.length})
                                    </h3>
                                </div>
                                {products.length === 0 ? (
                                    <p className="text-muted-foreground text-sm">No products tagged.</p>
                                ) : (
                                    <div className="overflow-hidden rounded-lg border">
                                        {products.map(p => (
                                            <Link
                                                key={p.id}
                                                to="/products/$id"
                                                params={{ id: p.id }}
                                                className="hover:bg-muted/40 flex items-center justify-between border-b px-3 py-2 text-sm last:border-b-0"
                                            >
                                                <span>{p.name}</span>
                                                <ChevronRight className="text-muted-foreground h-4 w-4" />
                                            </Link>
                                        ))}
                                    </div>
                                )}
                            </section>

                            <section className="space-y-2">
                                <div className="flex items-center gap-2">
                                    <Box className="text-muted-foreground h-4 w-4" />
                                    <h3 className="text-sm font-semibold">
                                        Variants ({variants.length})
                                    </h3>
                                </div>
                                {variants.length === 0 ? (
                                    <p className="text-muted-foreground text-sm">No variants tagged.</p>
                                ) : (
                                    <div className="overflow-hidden rounded-lg border">
                                        {variants.map(v => (
                                            <Link
                                                key={v.id}
                                                to="/product-variants/$id"
                                                params={{ id: v.id }}
                                                className="hover:bg-muted/40 flex items-center justify-between gap-2 border-b px-3 py-2 text-sm last:border-b-0"
                                            >
                                                <span>{v.name}</span>
                                                <span className="flex items-center gap-2">
                                                    {v.sku && (
                                                        <Badge variant="outline" className="text-xs">
                                                            {v.sku}
                                                        </Badge>
                                                    )}
                                                    <ChevronRight className="text-muted-foreground h-4 w-4" />
                                                </span>
                                            </Link>
                                        ))}
                                    </div>
                                )}
                            </section>
                        </>
                    )}
                </CardContent>
            </Card>
        </Page>
    );
}

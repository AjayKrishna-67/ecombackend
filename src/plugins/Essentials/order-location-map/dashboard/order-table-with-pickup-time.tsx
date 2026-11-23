import {
    addCustomFields,
    Badge,
    Button,
    DataTable,
    DetailPageButton,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
    getColumnVisibility,
    getFieldsFromDocumentNode,
    graphql,
    JsonViewer,
    Money,
    TableCell,
    TableRow,
    useGeneratedColumns,
    useLocalFormat,
    useUserSettings,
    VendureImage,
} from '@vendure/dashboard';
import { Clock, EllipsisVertical } from 'lucide-react';
import React, { Fragment, useMemo } from 'react';

import { visibleOrderLines } from './visible-order-lines';

/**
 * The order detail page's order table, with one addition: on a Take Away
 * order the Shipping row shows the pickup time the customer chose next to
 * the shipping method, with the store's hours beside it.
 *
 * This is a copy of the dashboard's own table (`@vendure/dashboard` 3.6.3,
 * `routes/_authenticated/_orders/components/order-table.tsx`,
 * `order-table-totals.tsx` and `money-gross-net.tsx`), registered as a
 * `replace` for the `order-table` block because the dashboard offers no hook
 * inside that row. Everything it imports is part of the dashboard's public
 * API; only the GraphQL document used to derive the columns is restated here
 * (the dashboard's is internal), with the same OrderLine fields.
 *
 * On a dashboard upgrade, diff this file against those sources and carry
 * over any change to the table. The pickup addition is the block marked
 * "Take Away" in OrderTableTotals below.
 */

// Same OrderLine selection as the dashboard's `orderLineFragment`; only the
// field names matter here, since they drive the generated columns and the
// rows come from the page's own entity.
const orderTableLinesDocument = graphql(`
    query OrderTableLines($id: ID!) {
        order(id: $id) {
            lines {
                ...OrderLine
            }
        }
    }
    fragment OrderLine on OrderLine {
        id
        createdAt
        updatedAt
        featuredAsset {
            id
            createdAt
            updatedAt
            languageCode
            name
            fileSize
            mimeType
            type
            preview
            source
            width
            height
            focalPoint {
                x
                y
            }
        }
        productVariant {
            id
            name
            sku
            trackInventory
            stockOnHand
        }
        discounts {
            adjustmentSource
            amount
            amountWithTax
            description
            initialValue
            type
        }
        fulfillmentLines {
            fulfillmentId
            quantity
        }
        unitPrice
        unitPriceWithTax
        proratedUnitPrice
        proratedUnitPriceWithTax
        quantity
        orderPlacedQuantity
        linePrice
        lineTax
        linePriceWithTax
        discountedLinePrice
        discountedLinePriceWithTax
    }
`);

function MoneyGrossNet({
    priceWithTax,
    price,
    currencyCode,
}: Readonly<{ priceWithTax: number; price: number; currencyCode: string }>) {
    return (
        <div className="flex flex-col gap-1">
            <div>
                <Money value={priceWithTax} currency={currencyCode} />
            </div>
            <div className="text-xs text-muted-foreground">
                <Money value={price} currency={currencyCode} />
            </div>
        </div>
    );
}

function createCustomizeColumns(currencyCode: string) {
    return {
        featuredAsset: {
            header: () => 'Image',
            accessorKey: 'featuredAsset',
            cell: ({ row }: { row: any }) => {
                const asset = row.original.featuredAsset;
                const fallbackAsset =
                    row.original.productVariant?.featuredAsset ??
                    row.original.productVariant?.product?.featuredAsset;
                return <VendureImage asset={asset ?? fallbackAsset} preset="tiny" />;
            },
        },
        productVariant: {
            header: () => 'Product',
            cell: ({ row }: { row: any }) => {
                const productVariant = row.original.productVariant;
                return (
                    <DetailPageButton
                        id={productVariant.id}
                        label={productVariant.name}
                        href={`/product-variants/${productVariant.id}`}
                    />
                );
            },
        },
        unitPriceWithTax: {
            header: () => 'Unit price',
            accessorKey: 'unitPriceWithTax',
            cell: ({ row }: { row: any }) => (
                <MoneyGrossNet
                    priceWithTax={row.original.unitPriceWithTax}
                    price={row.original.unitPrice}
                    currencyCode={currencyCode}
                />
            ),
        },
        fulfillmentLines: {
            cell: ({ row }: { row: any }) => (
                <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
                        <EllipsisVertical />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                        <JsonViewer data={row.original.fulfillmentLines} viewOnly rootFontSize={12} />
                    </DropdownMenuContent>
                </DropdownMenu>
            ),
        },
        quantity: {
            header: () => 'Quantity',
            accessorKey: 'quantity',
        },
        unitPrice: {
            cell: ({ row }: { row: any }) => <Money currency={currencyCode} value={row.original.unitPrice} />,
        },
        proratedUnitPrice: {
            cell: ({ row }: { row: any }) => (
                <Money currency={currencyCode} value={row.original.proratedUnitPrice} />
            ),
        },
        proratedUnitPriceWithTax: {
            cell: ({ row }: { row: any }) => (
                <Money currency={currencyCode} value={row.original.proratedUnitPriceWithTax} />
            ),
        },
        linePrice: {
            cell: ({ row }: { row: any }) => <Money currency={currencyCode} value={row.original.linePrice} />,
        },
        discountedLinePrice: {
            cell: ({ row }: { row: any }) => (
                <Money currency={currencyCode} value={row.original.discountedLinePrice} />
            ),
        },
        lineTax: {
            cell: ({ row }: { row: any }) => <Money currency={currencyCode} value={row.original.lineTax} />,
        },
        linePriceWithTax: {
            header: () => 'Total',
            accessorKey: 'linePriceWithTax',
            cell: ({ row }: { row: any }) => (
                <MoneyGrossNet
                    priceWithTax={row.original.linePriceWithTax}
                    price={row.original.linePrice}
                    currencyCode={currencyCode}
                />
            ),
        },
        discountedLinePriceWithTax: {
            cell: ({ row }: { row: any }) => (
                <Money currency={currencyCode} value={row.original.discountedLinePriceWithTax} />
            ),
        },
        discounts: {
            header: () => 'Discounts',
            cell: ({ row }: { row: any }) => {
                const discounts = row.original.discounts;
                if (!discounts?.length) return null;
                return (
                    <div className="grid grid-cols-[auto_1fr] items-start gap-x-2 gap-y-1">
                        {discounts.map((discount: any, index: number) => (
                            <Fragment key={index}>
                                <span>{discount.description}</span>
                                <MoneyGrossNet
                                    priceWithTax={discount.amountWithTax}
                                    price={discount.amount}
                                    currencyCode={currencyCode}
                                />
                            </Fragment>
                        ))}
                    </div>
                );
            },
        },
    };
}

function OrderTableTotals({ order, columnCount }: Readonly<{ order: any; columnCount: number }>) {
    const { formatCurrency } = useLocalFormat();
    const currencyCode: string = order.currencyCode;

    // Take Away: the time the customer chose, and the store's hours as they
    // were when the order was placed. An unset hours struct comes back as
    // { from: null, to: null }.
    const oc = order.customFields;
    const isTakeAway = oc?.isTakeAway === true;
    const pickupTime: string | null = isTakeAway ? oc?.pickupTime || null : null;
    const pickupHours: string | null =
        isTakeAway && oc?.pickupSlot?.from && oc?.pickupSlot?.to
            ? `${oc.pickupSlot.from} - ${oc.pickupSlot.to}`
            : null;

    return (
        <>
            {order.surcharges?.length > 0
                ? order.surcharges.map((surcharge: any, index: number) => (
                      <TableRow key={`${surcharge.description}-${index}`}>
                          <TableCell colSpan={columnCount - 1} className="h-12">
                              Surcharge: {surcharge.description}
                          </TableCell>
                          <TableCell colSpan={1} className="h-12">
                              <MoneyGrossNet
                                  priceWithTax={surcharge.priceWithTax}
                                  price={surcharge.price}
                                  currencyCode={currencyCode}
                              />
                          </TableCell>
                      </TableRow>
                  ))
                : null}
            {order.discounts?.length > 0
                ? order.discounts.map((discount: any, index: number) => (
                      <TableRow key={`${discount.description}-${index}`}>
                          <TableCell colSpan={columnCount - 1} className="h-12">
                              Discount: {discount.description}
                          </TableCell>
                          <TableCell colSpan={1} className="h-12">
                              <MoneyGrossNet
                                  priceWithTax={discount.amountWithTax}
                                  price={discount.amount}
                                  currencyCode={currencyCode}
                              />
                          </TableCell>
                      </TableRow>
                  ))
                : null}
            <TableRow>
                <TableCell colSpan={columnCount - 1} className="h-12">
                    Sub total
                </TableCell>
                <TableCell colSpan={1} className="h-12">
                    <MoneyGrossNet
                        priceWithTax={order.subTotalWithTax}
                        price={order.subTotal}
                        currencyCode={currencyCode}
                    />
                </TableCell>
            </TableRow>
            <TableRow>
                <TableCell colSpan={columnCount - 1} className="h-12">
                    <div className="flex flex-wrap items-center gap-1">
                        <div>Shipping</div>
                        {order.shippingLines.map((sl: any) => (
                            <Badge variant="outline" key={sl.id}>
                                {sl.shippingMethod.name}
                                {order.shippingLines.length > 1
                                    ? ` (${formatCurrency(sl.discountedPriceWithTax, order.currencyCode)})`
                                    : ''}
                            </Badge>
                        ))}
                        {/* Take Away: pickup time next to the shipping method */}
                        {isTakeAway ? (
                            <>
                                <Badge variant="secondary" className="gap-1">
                                    <Clock className="h-3 w-3" />
                                    {pickupTime ? `Pickup time ${pickupTime}` : 'No pickup time chosen'}
                                </Badge>
                                {pickupHours ? (
                                    <span className="text-xs text-muted-foreground">Store hours {pickupHours}</span>
                                ) : null}
                            </>
                        ) : null}
                    </div>
                </TableCell>
                <TableCell colSpan={1} className="h-12">
                    <MoneyGrossNet
                        priceWithTax={order.shippingWithTax}
                        price={order.shipping}
                        currencyCode={currencyCode}
                    />
                </TableCell>
            </TableRow>
            <TableRow>
                <TableCell colSpan={columnCount - 1} className="h-12 font-bold">
                    Total
                </TableCell>
                <TableCell colSpan={1} className="h-12 font-bold">
                    <MoneyGrossNet
                        priceWithTax={order.totalWithTax}
                        price={order.total}
                        currencyCode={currencyCode}
                    />
                </TableCell>
            </TableRow>
        </>
    );
}

export function OrderTableWithPickupTime({ order, pageId }: Readonly<{ order: any; pageId: string }>) {
    const { setTableSettings, settings } = useUserSettings();
    const tableSettings = pageId ? settings.tableSettings?.[pageId] : undefined;

    const defaultColumnVisibility = tableSettings?.columnVisibility ?? {
        featuredAsset: true,
        productVariant: true,
        unitPriceWithTax: true,
        quantity: true,
        linePriceWithTax: true,
    };
    const columnOrder = tableSettings?.columnOrder ?? [
        'featuredAsset',
        'productVariant',
        'unitPriceWithTax',
        'quantity',
        'linePriceWithTax',
    ];
    const currencyCode: string = order.currencyCode;

    const fields = getFieldsFromDocumentNode(
        addCustomFields(orderTableLinesDocument, { includeNestedFragments: ['OrderLine'] }),
        ['order', 'lines'],
    );

    const customizeColumns = useMemo(() => createCustomizeColumns(currencyCode), [currencyCode]);

    const { columns, customFieldColumnNames } = useGeneratedColumns({
        fields,
        rowActions: [],
        customizeColumns: customizeColumns as any,
        deleteMutation: undefined,
        defaultColumnOrder: columnOrder,
        includeSelectionColumn: false,
        includeActionsColumn: false,
        enableSorting: false,
    });

    const columnVisibility = getColumnVisibility(columns, defaultColumnVisibility, customFieldColumnNames);
    // -2 for the "actions" and "selection" columns, as in the dashboard.
    const visibleColumnCount = Object.values(columnVisibility).filter(Boolean).length - 2;
    const data = visibleOrderLines<{ quantity: number }>(order.lines);

    return (
        <div className="w-full">
            <DataTable
                columns={columns as any}
                data={data as any}
                totalItems={data.length}
                itemsPerPage={data.length}
                disableViewOptions={false}
                defaultColumnVisibility={columnVisibility}
                onColumnVisibilityChange={(_: unknown, visibility: any) => {
                    setTableSettings(pageId, 'columnVisibility', visibility);
                }}
                setTableOptions={(options: any) => ({
                    ...options,
                    manualPagination: false,
                    manualSorting: false,
                    manualFiltering: false,
                })}
            >
                <OrderTableTotals order={order} columnCount={visibleColumnCount} />
            </DataTable>
        </div>
    );
}

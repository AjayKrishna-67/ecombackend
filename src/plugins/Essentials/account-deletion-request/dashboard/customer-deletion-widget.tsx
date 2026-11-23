import {
    api,
    Button,
    DashboardBaseWidget,
    Spinner,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    useLocalFormat,
} from '@vendure/dashboard';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import React, { useState } from 'react';
import { DeletionRequest, getDeletionRequestsDocument } from './queries';

const PAGE_SIZE = 10;

export function CustomerDeletionWidget() {
    const { formatDate } = useLocalFormat();
    const [page, setPage] = useState(0);
    const { data, isLoading, isError } = useQuery({
        queryKey: ['customer-deletion-requests', page],
        queryFn: () => api.query(getDeletionRequestsDocument, { skip: page * PAGE_SIZE, take: PAGE_SIZE }),
    });

    const result = (data as any)?.customersWithDeletionRequest;
    const items: DeletionRequest[] = result?.items ?? [];
    const totalItems: number = result?.totalItems ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));

    return (
        <DashboardBaseWidget
            id="customer-deletion-requests"
            title="Customer Deletion Requests"
            description="Customers who requested account deletion"
        >
            {isLoading ? (
                <div className="flex justify-center p-6">
                    <Spinner />
                </div>
            ) : isError ? (
                <div className="text-destructive p-4 text-sm">Failed to load deletion requests.</div>
            ) : items.length === 0 ? (
                <div className="text-muted-foreground p-6 text-center text-sm">No deletion requests.</div>
            ) : (
                <div className="space-y-3">
                    <div className="max-h-72 overflow-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Customer</TableHead>
                                    <TableHead>Phone</TableHead>
                                    <TableHead>Reason</TableHead>
                                    <TableHead>Requested</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {items.map(req => (
                                    <TableRow key={req.id}>
                                        <TableCell>
                                            <Link
                                                className="text-primary hover:underline"
                                                to="/customers/$id"
                                                params={{ id: req.id }}
                                            >
                                                {req.emailAddress}
                                            </Link>
                                        </TableCell>
                                        <TableCell>{req.phoneNumber || '-'}</TableCell>
                                        <TableCell>{req.reason || '-'}</TableCell>
                                        <TableCell>{req.requestedDate ? formatDate(req.requestedDate) : '-'}</TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                    {totalPages > 1 && (
                        <div className="flex items-center justify-between text-sm">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={page === 0}
                                onClick={() => setPage(p => Math.max(0, p - 1))}
                            >
                                Previous
                            </Button>
                            <span className="text-muted-foreground">
                                Page {page + 1} of {totalPages}
                            </span>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={page + 1 >= totalPages}
                                onClick={() => setPage(p => p + 1)}
                            >
                                Next
                            </Button>
                        </div>
                    )}
                </div>
            )}
        </DashboardBaseWidget>
    );
}

import {
    api,
    Badge,
    Button,
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Input,
    Label,
    Page,
    PageTitle,
    Spinner,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
    toast,
    useLocalFormat,
} from '@vendure/dashboard';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import React, { useEffect, useState } from 'react';
import {
    createLoyaltyConfigDocument,
    createReferralConfigDocument,
    deleteLoyaltyConfigDocument,
    deleteReferralConfigDocument,
    getActiveChannelDocument,
    getLoyaltyConfigDocument,
    getReferralConfigDocument,
    getReferralsDocument,
    LoyaltyConfig,
    Referral,
    ReferralConfig,
    ReferralCustomer,
    updateLoyaltyConfigDocument,
    updateReferralConfigDocument,
} from './queries';

function customerName(c: ReferralCustomer): string {
    const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim();
    return name || c.emailAddress;
}

export function LoyaltyPointsConfigPage() {
    const queryClient = useQueryClient();
    const { formatDate } = useLocalFormat();

    const { data: channelData } = useQuery({
        queryKey: ['active-channel'],
        queryFn: () => api.query(getActiveChannelDocument),
    });
    const { data: loyaltyData, isLoading: loyaltyLoading } = useQuery({
        queryKey: ['loyalty-config'],
        queryFn: () => api.query(getLoyaltyConfigDocument),
    });
    const { data: referralData } = useQuery({
        queryKey: ['referral-config'],
        queryFn: () => api.query(getReferralConfigDocument),
    });

    const activeChannelId: string | undefined = (channelData as any)?.activeChannel?.id;
    const loyaltyConfig: LoyaltyConfig | null = (loyaltyData as any)?.loyaltyPointsConfig ?? null;
    const referralConfig: ReferralConfig | null = (referralData as any)?.referralChannelPoints ?? null;

    const [rupeesPerPoint, setRupeesPerPoint] = useState('');
    const [pointsPerRupee, setPointsPerRupee] = useState('');
    const [referralPoints, setReferralPoints] = useState('');

    const { data: referralsData, isLoading: referralsLoading } = useQuery({
        queryKey: ['referral-history'],
        queryFn: () => api.query(getReferralsDocument),
    });
    const referrals: Referral[] = (referralsData as any)?.referrals?.items ?? [];

    useEffect(() => {
        if (loyaltyConfig) {
            setRupeesPerPoint(String(loyaltyConfig.rupeesPerPoint));
            setPointsPerRupee(String(loyaltyConfig.pointsPerRupee));
        }
    }, [loyaltyConfig]);
    useEffect(() => {
        if (referralConfig) {
            setReferralPoints(String(referralConfig.points));
        }
    }, [referralConfig]);

    const saveLoyalty = useMutation({
        mutationFn: () => {
            const input = {
                rupeesPerPoint: Number(rupeesPerPoint),
                pointsPerRupee: Number(pointsPerRupee),
                channelIds: activeChannelId ? [activeChannelId] : [],
            };
            return loyaltyConfig?.id
                ? api.mutate(updateLoyaltyConfigDocument, { id: loyaltyConfig.id, input })
                : api.mutate(createLoyaltyConfigDocument, { input });
        },
        onSuccess: () => {
            toast.success('Configuration saved');
            queryClient.invalidateQueries({ queryKey: ['loyalty-config'] });
        },
        onError: (e: any) => toast.error(`Save failed: ${e.message}`),
    });
    const deleteLoyalty = useMutation({
        mutationFn: () => api.mutate(deleteLoyaltyConfigDocument, { id: loyaltyConfig!.id }),
        onSuccess: () => {
            toast.success('Configuration deleted');
            setRupeesPerPoint('');
            setPointsPerRupee('');
            queryClient.invalidateQueries({ queryKey: ['loyalty-config'] });
        },
        onError: (e: any) => toast.error(`Delete failed: ${e.message}`),
    });

    const saveReferral = useMutation({
        mutationFn: () => {
            const input = { points: Number(referralPoints) };
            return referralConfig?.id
                ? api.mutate(updateReferralConfigDocument, { id: referralConfig.id, input })
                : api.mutate(createReferralConfigDocument, { input });
        },
        onSuccess: () => {
            toast.success('Referral points saved');
            queryClient.invalidateQueries({ queryKey: ['referral-config'] });
        },
        onError: (e: any) => toast.error(`Save failed: ${e.message}`),
    });
    const deleteReferral = useMutation({
        mutationFn: () => api.mutate(deleteReferralConfigDocument, { id: referralConfig!.id }),
        onSuccess: () => {
            toast.success('Referral config deleted');
            setReferralPoints('');
            queryClient.invalidateQueries({ queryKey: ['referral-config'] });
        },
        onError: (e: any) => toast.error(`Delete failed: ${e.message}`),
    });

    return (
        <Page pageId="loyalty-points-config">
            <PageTitle>Loyalty &amp; Rewards</PageTitle>
            <div className="px-4 pb-6">
                {loyaltyLoading ? (
                    <div className="flex justify-center p-6">
                        <Spinner />
                    </div>
                ) : (
                    <div className="grid gap-6 md:grid-cols-2">
                        {/* Point conversion */}
                        <Card>
                            <CardHeader>
                                <CardTitle>Point Conversion Rates</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="space-y-1">
                                    <Label>Rupees per Point</Label>
                                    <Input
                                        type="number"
                                        min={1}
                                        value={rupeesPerPoint}
                                        onChange={e => setRupeesPerPoint(e.target.value)}
                                    />
                                </div>
                                <div className="space-y-1">
                                    <Label>Points per Rupee</Label>
                                    <Input
                                        type="number"
                                        min={1}
                                        value={pointsPerRupee}
                                        onChange={e => setPointsPerRupee(e.target.value)}
                                    />
                                </div>
                                <div className="flex gap-2">
                                    <Button
                                        disabled={
                                            !rupeesPerPoint ||
                                            !pointsPerRupee ||
                                            !activeChannelId ||
                                            saveLoyalty.isPending
                                        }
                                        onClick={() => saveLoyalty.mutate()}
                                    >
                                        {loyaltyConfig?.id ? 'Update' : 'Create'}
                                    </Button>
                                    {loyaltyConfig?.id && (
                                        <Button
                                            variant="destructive"
                                            disabled={deleteLoyalty.isPending}
                                            onClick={() => deleteLoyalty.mutate()}
                                        >
                                            Delete
                                        </Button>
                                    )}
                                </div>
                            </CardContent>
                        </Card>

                        {/* Referral points */}
                        <Card>
                            <CardHeader>
                                <CardTitle>Referral Points</CardTitle>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <p className="text-muted-foreground text-sm">
                                    Points awarded when a referred customer&apos;s first order is delivered.
                                </p>
                                <div className="space-y-1">
                                    <Label>Points</Label>
                                    <Input
                                        type="number"
                                        min={0}
                                        value={referralPoints}
                                        onChange={e => setReferralPoints(e.target.value)}
                                    />
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        disabled={!referralPoints || saveReferral.isPending}
                                        onClick={() => saveReferral.mutate()}
                                    >
                                        {referralConfig?.id ? 'Update' : 'Create'}
                                    </Button>
                                    {referralConfig?.id && (
                                        <Button
                                            variant="destructive"
                                            disabled={deleteReferral.isPending}
                                            onClick={() => deleteReferral.mutate()}
                                        >
                                            Delete
                                        </Button>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                )}

                <Card className="mt-6">
                        <CardHeader>
                            <CardTitle>Referral History</CardTitle>
                        </CardHeader>
                        <CardContent>
                            {referralsLoading ? (
                                <div className="flex justify-center p-6">
                                    <Spinner />
                                </div>
                            ) : referrals.length === 0 ? (
                                <div className="text-muted-foreground p-6 text-center text-sm">
                                    No referrals yet.
                                </div>
                            ) : (
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>#</TableHead>
                                            <TableHead>Date</TableHead>
                                            <TableHead>Referrer</TableHead>
                                            <TableHead>Referred</TableHead>
                                            <TableHead>Status</TableHead>
                                            <TableHead className="text-right">Points</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {referrals.map(ref => (
                                            <TableRow key={ref.id}>
                                                <TableCell>{ref.referralNumber}</TableCell>
                                                <TableCell>{formatDate(ref.createdAt)}</TableCell>
                                                <TableCell>
                                                    <Link
                                                        to="/customers/$id"
                                                        params={{ id: ref.referrer.id }}
                                                        className="text-primary hover:underline"
                                                    >
                                                        {customerName(ref.referrer)}
                                                    </Link>
                                                </TableCell>
                                                <TableCell>
                                                    <Link
                                                        to="/customers/$id"
                                                        params={{ id: ref.referredCustomer.id }}
                                                        className="text-primary hover:underline"
                                                    >
                                                        {customerName(ref.referredCustomer)}
                                                    </Link>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="secondary">{ref.status}</Badge>
                                                </TableCell>
                                                <TableCell className="text-right">{ref.points}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            )}
                        </CardContent>
                    </Card>
            </div>
        </Page>
    );
}

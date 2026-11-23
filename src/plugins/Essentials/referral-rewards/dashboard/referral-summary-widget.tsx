import { api, DashboardBaseWidget, Spinner } from '@vendure/dashboard';
import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { getReferralSummaryDocument, ReferralSummaryReport } from './queries';

type PeriodKey = 'today' | 'yesterday' | 'allTime';

const PERIODS: Array<{ key: PeriodKey; label: string }> = [
    { key: 'today', label: 'Today' },
    { key: 'yesterday', label: 'Yesterday' },
    { key: 'allTime', label: 'All Time' },
];

function Stat({ label, value, className }: { label: string; value: number; className: string }) {
    return (
        <div className={'rounded-lg border p-3 text-center ' + className}>
            <div className="text-2xl font-bold leading-tight">{value}</div>
            <div className="text-muted-foreground mt-1 text-xs font-medium uppercase tracking-wide">{label}</div>
        </div>
    );
}

export function ReferralSummaryWidget() {
    const [period, setPeriod] = useState<PeriodKey>('today');
    const { data, isLoading } = useQuery({
        queryKey: ['referral-summary'],
        queryFn: () => api.query(getReferralSummaryDocument),
    });
    const summary = (data as any)?.referralSummary as ReferralSummaryReport | undefined;
    const active = summary?.[period];

    return (
        <DashboardBaseWidget
            id="referral-summary-widget"
            title="Referral Summary"
            description="Referral activity overview"
        >
            {isLoading ? (
                <div className="flex justify-center p-6">
                    <Spinner />
                </div>
            ) : !summary ? (
                <div className="text-muted-foreground p-6 text-center text-sm">No referral data.</div>
            ) : (
                <div className="space-y-3">
                    <div className="flex gap-1 border-b">
                        {PERIODS.map(p => (
                            <button
                                key={p.key}
                                onClick={() => setPeriod(p.key)}
                                className={
                                    '-mb-px border-b-2 px-4 py-1.5 text-sm ' +
                                    (period === p.key
                                        ? 'border-primary text-primary font-semibold'
                                        : 'text-muted-foreground border-transparent')
                                }
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <Stat
                            label="Total"
                            value={active?.totalReferrals ?? 0}
                            className="bg-primary/10 text-primary border-primary/20"
                        />
                        <Stat
                            label="Registered"
                            value={active?.registered ?? 0}
                            className="bg-muted text-foreground"
                        />
                        <Stat
                            label="Eligible"
                            value={active?.eligible ?? 0}
                            className="bg-success/10 text-success border-success/20"
                        />
                        <Stat
                            label="Claimed"
                            value={active?.claimed ?? 0}
                            className="bg-accent text-accent-foreground"
                        />
                    </div>
                </div>
            )}
        </DashboardBaseWidget>
    );
}

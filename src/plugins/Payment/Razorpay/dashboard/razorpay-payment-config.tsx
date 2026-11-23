import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    Checkbox,
    DashboardFormComponent,
    Input,
    Label,
} from '@vendure/dashboard';
import React, { useEffect, useMemo, useState } from 'react';

interface RazorpayConfigValue {
    key_id?: string;
    key_secret?: string;
    webhook_enabled?: boolean;
    webhook_url?: string;
    webhook_secret?: string;
}

function parseConfig(raw: unknown): RazorpayConfigValue {
    if (raw && typeof raw === 'object') return raw as RazorpayConfigValue;
    if (typeof raw === 'string' && raw.length > 0) {
        try {
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }
    return {};
}

export const RazorpayPaymentConfig: DashboardFormComponent = ({ value, onChange, onBlur, disabled }) => {
    const initial = useMemo(() => parseConfig(value), [value]);
    const [state, setState] = useState<RazorpayConfigValue>(initial);

    useEffect(() => {
        setState(parseConfig(value));
    }, [value]);

    function update(patch: Partial<RazorpayConfigValue>) {
        const next = { ...state, ...patch };
        if (!next.webhook_enabled) {
            next.webhook_url = '';
            next.webhook_secret = '';
        }
        setState(next);
        onChange(JSON.stringify(next));
    }

    const webhookEnabled = state.webhook_enabled === true;

    return (
        <div className="space-y-4">
            <Card>
                <CardHeader>
                    <CardTitle className="text-sm">API Credentials</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="space-y-1.5">
                        <Label htmlFor="rzp-key-id">Key ID</Label>
                        <Input
                            id="rzp-key-id"
                            type="text"
                            value={state.key_id ?? ''}
                            placeholder="rzp_live_xxxxxxxxxx"
                            disabled={disabled}
                            onChange={(e) => update({ key_id: e.target.value })}
                            onBlur={onBlur}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="rzp-key-secret">Key Secret</Label>
                        <Input
                            id="rzp-key-secret"
                            type="password"
                            value={state.key_secret ?? ''}
                            placeholder="Enter key secret"
                            disabled={disabled}
                            onChange={(e) => update({ key_secret: e.target.value })}
                            onBlur={onBlur}
                        />
                    </div>
                </CardContent>
            </Card>

            <Card className="border-l-primary border-l-4">
                <CardHeader>
                    <CardTitle className="text-sm">Webhook Configuration (Optional)</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    <div className="flex items-center gap-2">
                        <Checkbox
                            id="rzp-webhook-enabled"
                            checked={webhookEnabled}
                            disabled={disabled}
                            onCheckedChange={(checked) => update({ webhook_enabled: checked === true })}
                        />
                        <Label htmlFor="rzp-webhook-enabled">Enable Webhooks</Label>
                    </div>

                    {!webhookEnabled && (
                        <p className="text-muted-foreground text-xs italic">
                            Turn on webhooks for automatic payment processing and better reliability.
                        </p>
                    )}

                    {webhookEnabled && (
                        <div className="border-border grid grid-cols-1 gap-4 border-t border-dashed pt-3 md:grid-cols-2">
                            <div className="space-y-1.5">
                                <Label htmlFor="rzp-webhook-url">Webhook URL</Label>
                                <Input
                                    id="rzp-webhook-url"
                                    type="text"
                                    value={state.webhook_url ?? ''}
                                    placeholder="https://yoursite.com/razorpay/webhook/"
                                    disabled={disabled}
                                    onChange={(e) => update({ webhook_url: e.target.value })}
                                    onBlur={onBlur}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label htmlFor="rzp-webhook-secret">Webhook Secret</Label>
                                <Input
                                    id="rzp-webhook-secret"
                                    type="password"
                                    value={state.webhook_secret ?? ''}
                                    placeholder="whsec_xxxxxxxxxx"
                                    disabled={disabled}
                                    onChange={(e) => update({ webhook_secret: e.target.value })}
                                    onBlur={onBlur}
                                />
                            </div>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
};

RazorpayPaymentConfig.metadata = { isFullWidth: true };

import { Order } from '@vendure/core';
import { BodyVar } from '../types';

function formatRupees(minor: number): string {
    return `₹${(minor / 100).toFixed(2)}`;
}

const TOKEN_RESOLVERS: Record<string, (order: Order) => string> = {
    '{customerName}': order => `${order.customer?.firstName ?? ''} ${order.customer?.lastName ?? ''}`.trim(),
    '{firstName}': order => order.customer?.firstName ?? '',
    '{orderCode}': order => order.code,
    '{cartTotal}': order => formatRupees(order.totalWithTax),
};

/** Maps an ordered bodyVars list to MSG91 `body_{n}` text components. */
export function resolveBodyVars(
    order: Order,
    bodyVars: BodyVar[],
): Record<string, { type: 'text'; value: string }> {
    const out: Record<string, { type: 'text'; value: string }> = {};
    bodyVars.forEach((bodyVar, index) => {
        const value =
            bodyVar.kind === 'token' ? TOKEN_RESOLVERS[bodyVar.value]?.(order) ?? '' : bodyVar.value;
        out[`body_${index + 1}`] = { type: 'text', value };
    });
    return out;
}

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@vendure/core', async () => {
    const actual = await vi.importActual<any>('@vendure/core');
    return {
        ...actual,
        Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() },
    };
});

import { ShiprocketQuickFulfillmentService } from './shiprocket-quick-fulfillment.service';

const quickFulfillment = (id: string, shiprocketOrderId: string) => ({
    id,
    customFields: { fulfillmentType: 'shiprocket-quick', shiprocketOrderId },
});
const regularFulfillment = (id: string) => ({ id, customFields: { fulfillmentType: 'manual' } });

describe('ShiprocketQuickFulfillmentService.cancelQuickOrderOnCancellation', () => {
    let shipRocket: { cancelQuickOrder: ReturnType<typeof vi.fn> };
    let orderService: { getOrderFulfillments: ReturnType<typeof vi.fn> };
    let connection: { getRepository: ReturnType<typeof vi.fn> };
    let service: ShiprocketQuickFulfillmentService;
    const ctx = {} as any;

    beforeEach(() => {
        shipRocket = { cancelQuickOrder: vi.fn(async () => true) };
        orderService = { getOrderFulfillments: vi.fn(async () => []) };
        connection = { getRepository: vi.fn() };
        service = new ShiprocketQuickFulfillmentService(
            shipRocket as any,
            orderService as any,
            connection as any,
        );
    });

    it('cancels using only the fulfillments already on the order — never a table-wide query', async () => {
        const order = {
            id: '1',
            code: 'ORDER1',
            fulfillments: [regularFulfillment('10'), quickFulfillment('11', '555')],
        } as any;

        await service.cancelQuickOrderOnCancellation(ctx, order);

        expect(shipRocket.cancelQuickOrder).toHaveBeenCalledWith([555]);
        expect(connection.getRepository).not.toHaveBeenCalled();
        expect(orderService.getOrderFulfillments).not.toHaveBeenCalled();
    });

    it('loads only this order\'s fulfillments when the order has none attached', async () => {
        const order = { id: '2', code: 'ORDER2' } as any;
        orderService.getOrderFulfillments.mockResolvedValue([quickFulfillment('12', '777')]);

        await service.cancelQuickOrderOnCancellation(ctx, order);

        expect(orderService.getOrderFulfillments).toHaveBeenCalledWith(ctx, order);
        expect(shipRocket.cancelQuickOrder).toHaveBeenCalledWith([777]);
        expect(connection.getRepository).not.toHaveBeenCalled();
    });

    it('does not call Shiprocket when the order has no Quick fulfillments', async () => {
        const order = { id: '3', code: 'ORDER3', fulfillments: [regularFulfillment('13')] } as any;

        await service.cancelQuickOrderOnCancellation(ctx, order);

        expect(shipRocket.cancelQuickOrder).not.toHaveBeenCalled();
    });
});

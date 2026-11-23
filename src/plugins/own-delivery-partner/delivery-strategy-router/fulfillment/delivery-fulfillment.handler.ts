import {
    FulfillmentHandler,
    LanguageCode,
    Injector,
    TransactionalConnection,
} from '@vendure/core';

let connection: TransactionalConnection;

export const deliveryFulfillmentHandler = new FulfillmentHandler({
    code: 'kaaikani-fulfillment',
    description: [
        {
            languageCode: LanguageCode.en,
            value: 'KaaiKani Fulfillment',
        },
    ],
    args: {
        fulfillmentConfig: {
            type: 'string',
            ui: { component: 'kaaikani-fulfillment-input' },
            label: [{ languageCode: LanguageCode.en, value: ' ' }],
        },
    },
    init: (injector: Injector) => {
        connection = injector.get(TransactionalConnection);
    },
    createFulfillment: async (ctx, orders, lines, args) => {
        // Parse the JSON config from the custom form input
        let config: { type: string; deliveryPersonId: string };
        try {
            config = JSON.parse(args.fulfillmentConfig);
        } catch (e) {
            throw new Error('Invalid fulfillment configuration');
        }

        const fulfillmentType = config.type || 'own-delivery-fleet';

        // ── Own Delivery Fleet ──
        if (fulfillmentType === 'own-delivery-fleet') {
            const deliveryPersonId = config.deliveryPersonId;
            if (!deliveryPersonId) {
                throw new Error('Please select a Delivery Person');
            }

            const administrator = await connection
                .getRepository(ctx, 'Administrator')
                .findOne({
                    where: { id: deliveryPersonId, deletedAt: null },
                }) as any;

            if (!administrator) {
                throw new Error(`Delivery person with ID ${deliveryPersonId} not found`);
            }

            const deliveryPersonName = `${administrator.firstName} ${administrator.lastName}`;
            const deliveryPersonPhone = administrator.customFields?.phoneNumber || '';

            return {
                method: 'Own Delivery Fleet',
                trackingCode: '',
                customFields: {
                    fulfillmentType: 'own-delivery-fleet',
                    deliveryPersonId: String(deliveryPersonId),
                    deliveryPersonName,
                    deliveryPersonPhone,
                },
            };
        }

        // ── Shiprocket Quick ──
        if (fulfillmentType === 'shiprocket-quick') {
            return {
                method: 'Shiprocket Quick',
                trackingCode: '',
                customFields: {
                    fulfillmentType: 'shiprocket-quick',
                },
            };
        }

        // ── Adloggs ── (order creation handled by AdloggsFulfillmentSubscriber)
        if (fulfillmentType === 'adloggs') {
            return {
                method: 'Adloggs',
                trackingCode: '',
                customFields: {
                    fulfillmentType: 'adloggs',
                },
            };
        }

        // ── Manual / Take Away ──
        if (fulfillmentType === 'manual') {
            return {
                method: 'Take Away',
                trackingCode: '',
                customFields: {
                    fulfillmentType: 'manual',
                },
            };
        }

        throw new Error(`Unknown fulfillment type: ${fulfillmentType}`);
    },
});

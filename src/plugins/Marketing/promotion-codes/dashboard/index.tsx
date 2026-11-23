import { defineDashboardExtension } from '@vendure/dashboard';

import { FreeProductQuantityInput } from './free-product-quantity-input';

defineDashboardExtension({
    customFormComponents: {
        customFields: [{ id: 'free-product-quantity-input', component: FreeProductQuantityInput }],
    },
});

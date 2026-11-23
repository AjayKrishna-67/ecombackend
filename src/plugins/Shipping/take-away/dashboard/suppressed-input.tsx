import React, { useEffect, useRef } from 'react';

import { findFieldRowWrapper } from './field-row-util';

/**
 * No-op control for `ShippingMethod.storeLongitude` / `storeMapUrl` — both
 * written by the Store Location Pin map. The dashboard renders each custom
 * field's label/description around the input, so returning null still leaves
 * the headings behind; this component instead hides its whole field row.
 */
export function TakeAwaySuppressedInput() {
    const ref = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        const host = ref.current;
        if (!host) {
            return;
        }
        const wrapper = findFieldRowWrapper(host);
        wrapper.style.display = 'none';
    }, []);

    return <span ref={ref} />;
}

import React, { useEffect, useRef } from 'react';

import { findFieldRowWrapper } from './field-row-util';

/**
 * Bridge between the hidden ShippingMethod store-location custom-field rows
 * and the picker rendered inside the Calculator card. Each hidden field
 * registers its own react-hook-form controller (value + onChange), so the
 * picker always writes through the REAL registered form fields — guaranteeing
 * the form becomes dirty (Create/Update button activates) and the values
 * save, regardless of how the page names its form paths.
 */
type Entry = { value: any; onChange: (v: any) => void };

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach(l => l());
}

export function getBridgeField(key: string): Entry | undefined {
    return entries.get(key);
}

export function subscribeBridge(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * Invisible input for the store-location custom fields: hides its row and
 * registers its controller with the bridge under the bare field name
 * (e.g. "storeLatitude").
 */
export function TakeAwayFieldBridgeInput(props: any) {
    const { value, onChange, name } = props;
    const ref = useRef<HTMLSpanElement>(null);
    const key = String(name ?? '').split('.').pop() ?? '';

    // Re-register on every render so the bridge always holds the live
    // controller and current value. Deliberately no unregister on unmount:
    // the field row may unmount on tab switches while the form field itself
    // stays registered — the picker must keep working with the last known
    // controller. Opening another method re-registers with fresh ones.
    useEffect(() => {
        if (key) {
            entries.set(key, { value, onChange });
            emit();
        }
    });

    useEffect(() => {
        if (ref.current) {
            findFieldRowWrapper(ref.current).style.display = 'none';
        }
    }, []);

    return <span ref={ref} />;
}

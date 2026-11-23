import { Injectable } from '@angular/core';
import { FormControl } from '@angular/forms';
import { BehaviorSubject } from 'rxjs';

/**
 * Connects the hidden Store Location custom-field controls (registered by
 * TakeAwayFieldBridgeComponent) with the picker rendered inside the
 * Calculator card (StoreLocationArgComponent). The calculator arg form is an
 * isolated form group in the Angular admin, so the picker cannot reach the
 * customFields group through the form tree — this service is the bridge.
 *
 * Controls stay registered for the page's lifetime (no unregister): the
 * custom-fields card renders tabs lazily, so the invisible field components
 * may be destroyed on tab switches while their FormControls live on in the
 * detail form. Opening another method re-registers fresh controls.
 */
@Injectable({ providedIn: 'root' })
export class StoreLocationBridge {
    private controls = new Map<string, FormControl>();
    /** Emits whenever a control registers. */
    readonly changes$ = new BehaviorSubject<number>(0);

    register(fieldName: string, control: FormControl) {
        this.controls.set(fieldName, control);
        this.changes$.next(this.changes$.value + 1);
    }

    get(fieldName: string): FormControl | undefined {
        return this.controls.get(fieldName);
    }
}

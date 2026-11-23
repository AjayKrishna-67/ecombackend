import { Component, Input, Output, EventEmitter, forwardRef } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR, ReactiveFormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';

@Component({
    selector: 'app-shipping-method-toggle',
    standalone: true,
    imports: [CommonModule, ReactiveFormsModule],
    template: `
        <div class="toggle-wrapper">
            <label class="toggle-switch">
                <input
                    type="checkbox"
                    [checked]="value"
                    (change)="onToggle($event)"
                    class="toggle-input"
                >
                <span class="toggle-slider"></span>
            </label>
            <span class="toggle-status">{{ value ? 'Enabled' : 'Disabled' }}</span>
        </div>
    `,
    styles: [`
        .toggle-wrapper {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .toggle-switch {
            position: relative;
            width: 44px;
            height: 24px;
            cursor: pointer;
        }

        .toggle-input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .toggle-slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: #cbd5e1;
            transition: 0.3s;
            border-radius: 24px;
        }

        .toggle-slider:before {
            position: absolute;
            content: "";
            height: 18px;
            width: 18px;
            left: 3px;
            bottom: 3px;
            background: white;
            transition: 0.3s;
            border-radius: 50%;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }

        .toggle-input:checked + .toggle-slider {
            background: #10b981;
        }

        .toggle-input:checked + .toggle-slider:before {
            transform: translateX(20px);
        }

        .toggle-status {
            font-size: 13px;
            font-weight: 500;
            color: var(--color-text-200, #666);
            transition: color 0.2s;
        }

        .toggle-input:checked ~ .toggle-status {
            color: var(--color-text-100, #333);
        }
    `],
    providers: [
        {
            provide: NG_VALUE_ACCESSOR,
            useExisting: forwardRef(() => ShippingMethodToggleComponent),
            multi: true,
        },
    ],
})
export class ShippingMethodToggleComponent implements ControlValueAccessor {
    @Input() value: boolean = true;
    @Output() valueChange = new EventEmitter<boolean>();

    onChange: (value: boolean) => void = () => {};
    onTouched: () => void = () => {};

    onToggle(event: any) {
        const newValue = event.target.checked;
        this.value = newValue;
        this.valueChange.emit(newValue);
        this.onChange(newValue);
        this.onTouched();
    }

    writeValue(value: boolean | null | undefined) {
        this.value = value ?? true;
    }

    registerOnChange(fn: (value: boolean) => void) {
        this.onChange = fn;
    }

    registerOnTouched(fn: () => void) {
        this.onTouched = fn;
    }
}

import { Component, OnInit } from '@angular/core';
import { FormControl } from '@angular/forms';
import { FormInputComponent, SharedModule } from '@vendure/admin-ui/core';
import { CommonModule } from '@angular/common';

@Component({
    selector: 'payment-window-status',
    template: `
        <div class="status-container">
            <div
                class="status-badge"
                [class.active]="formControl.value === true"
                [class.inactive]="formControl.value !== true"
            >
                <span class="status-dot"></span>
                <span class="status-text">{{ formControl.value === true ? 'Active' : 'Inactive' }}</span>
            </div>
        </div>
    `,
    styles: [`
        :host {
            display: block;
            width: 100%;
        }
        .status-container {
            padding: 4px 0;
        }
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            border-radius: 16px;
            font-size: 12px;
            font-weight: 600;
            letter-spacing: 0.5px;
            cursor: default;
            user-select: none;
        }
        .status-badge.active {
            background-color: rgba(40, 167, 69, 0.15);
            color: #28a745;
            border: 1px solid rgba(40, 167, 69, 0.3);
        }
        .status-badge.inactive {
            background-color: rgba(108, 117, 125, 0.15);
            color: #6c757d;
            border: 1px solid rgba(108, 117, 125, 0.3);
        }
        .status-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
        }
        .status-badge.active .status-dot {
            background-color: #28a745;
            box-shadow: 0 0 4px rgba(40, 167, 69, 0.6);
        }
        .status-badge.inactive .status-dot {
            background-color: #6c757d;
        }
        .status-text {
            text-transform: uppercase;
        }
    `],
    standalone: true,
    imports: [CommonModule, SharedModule]
})
export class PaymentWindowStatusComponent implements FormInputComponent, OnInit {
    readonly: boolean = true;
    formControl!: FormControl;
    config: any;

    ngOnInit() {
        // Make this field read-only - disable the form control
        if (this.formControl) {
            this.formControl.disable();
        }
    }

    static readonly id = 'payment-window-status';
}

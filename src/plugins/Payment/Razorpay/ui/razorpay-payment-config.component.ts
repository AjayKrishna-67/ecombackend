// src/plugins/Payment/Razorpay/ui/razorpay-payment-config.component.ts

import { Component, OnInit, ViewEncapsulation } from '@angular/core';
import { FormControl, FormGroup, Validators } from '@angular/forms';
import {  FormInputComponent, SharedModule } from '@vendure/admin-ui/core';

@Component({
    standalone: true,
    imports: [SharedModule],
    encapsulation: ViewEncapsulation.None,
    selector: 'razorpay-payment-config',
    template: `
        <div class="razorpay-config">
            <!-- API Credentials Section -->
            <div class="config-section">
                <h4 class="section-title">API Credentials</h4>
                <div class="field-group">
                    <vdr-form-field label="Key ID" [for]="'key_id'">
                        <input
                            id="key_id"
                            type="text"
                            [formControl]="formGroup.get('key_id')"
                            placeholder="rzp_live_xxxxxxxxxx"
                        />
                    </vdr-form-field>

                    <vdr-form-field label="Key Secret" [for]="'key_secret'">
                        <input
                            id="key_secret"
                            type="password"
                            [formControl]="formGroup.get('key_secret')"
                            placeholder="Enter key secret"
                        />
                    </vdr-form-field>
                </div>
            </div>

            <div class="config-section webhook-section">
                <h4 class="section-title">Webhook Configuration (Optional)</h4>
                
                <label class="clr-control-container clr-control-inline">
                    <input
                        type="checkbox"
                        clrCheckbox
                        [formControl]="formGroup.get('webhook_enabled')"
                    />
                    <span class="clr-control-label">Enable Webhooks</span>
                </label>
                
                <p class="section-description" *ngIf="!webhookEnabled">
                    Turn on webhooks for automatic payment processing and better reliability.
                </p>

                <!-- Webhook Fields (conditional) -->
                <div class="webhook-fields" *ngIf="webhookEnabled">
                    <div class="field-group">
                        <vdr-form-field label="Webhook URL" [for]="'webhook_url'">
                            <input
                                id="webhook_url"
                                type="text"
                                [formControl]="formGroup.get('webhook_url')"
                                placeholder="https://yoursite.com/razorpay/webhook/"
                            />
                        </vdr-form-field>

                        <vdr-form-field label="Webhook Secret" [for]="'webhook_secret'">
                            <input
                                id="webhook_secret"
                                type="password"
                                [formControl]="formGroup.get('webhook_secret')"
                                placeholder="whsec_xxxxxxxxxx"
                            />
                        </vdr-form-field>
                    </div>
                </div>
            </div>
        </div>
    `,
    styles: [`

      /* 1. Target the CONTAINER that holds your component */
        /* We use the :has() selector to find the specific row containing your component */
        .clr-form-control:has(razorpay-payment-config),
        vdr-form-field:has(razorpay-payment-config) {
            margin-top: 0 !important;
            padding-top: 0 !important;
        }

        /* 2. Hide the LABEL COLUMN (The empty space on the left) */
        /* In Clarity/Vendure, this is usually a label with class clr-col-md-3 */
        .clr-form-control:has(razorpay-payment-config) label,
        .clr-form-control:has(razorpay-payment-config) .clr-col-md-3,
        vdr-form-field:has(razorpay-payment-config) label,
        vdr-form-field:has(razorpay-payment-config) .clr-col-md-3 {
            display: none !important;
            width: 0 !important;
            flex: 0 0 0 !important;
            margin: 0 !important;
        }

        /* 3. Expand the INPUT COLUMN (Your component) to full width */
        /* This targets the container div that holds your component */
        .clr-form-control:has(razorpay-payment-config) .clr-control-container,
        .clr-form-control:has(razorpay-payment-config) .clr-col-md-9,
        vdr-form-field:has(razorpay-payment-config) .clr-control-container,
        vdr-form-field:has(razorpay-payment-config) .clr-col-md-9 {
            width: 100% !important;
            max-width: 100% !important;
            flex: 0 0 100% !important;
            padding-left: 0 !important;
            margin-left: 0 !important;
        }
        
        /* --- LAYOUT OVERRIDE END --- */

        /* Your Custom Component Styles */
        .razorpay-config {
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            /* Add margin top to separate from the "Razorpay Payment" title */
            margin-top: 0.5rem; 
        }

        .config-section {
            padding: 1rem;
            border: 1px solid var(--color-component-border-300);
            border-radius: 6px;
            background: var(--color-component-bg-100);
        }

        .section-title {
            font-size: 0.9375rem;
            font-weight: 600;
            color: var(--color-text-100);
            margin: 0 0 1rem 0;
            /* Optional: Add a subtle underline */
            border-bottom: 1px solid var(--color-component-border-200);
            padding-bottom: 0.5rem;
        }

        .section-description {
            font-size: 0.8125rem;
            color: var(--color-text-300);
            margin: 0.5rem 0;
            font-style: italic;
        }

        /* Improved Grid for Inputs */
        .field-group {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1.5rem; /* More breathing room */
        }

        @media (max-width: 768px) {
            .field-group {
                grid-template-columns: 1fr;
            }
        }

        .webhook-section {
            border-left: 4px solid var(--color-primary-400); /* Visual accent */
            background: var(--color-component-bg-100);
        }

        .webhook-fields {
            margin-top: 1rem;
            padding-top: 1rem;
            border-top: 1px dashed var(--color-component-border-300);
        }

        /* Ensure inputs fill the grid cells */
        input[type="text"],
        input[type="password"] {
            width: 100%;
        }
    `]
})
export class RazorpayPaymentConfigComponent implements FormInputComponent, OnInit {
    // Injected by Vendure's FormInputComponent system
    readonly!: boolean;
    formControl!: FormControl;
    config: any;

    formGroup!: FormGroup;
    webhookEnabled = false;

    ngOnInit() {
        // Create form group with all fields
        this.formGroup = new FormGroup({
            key_id: new FormControl('', Validators.required),
            key_secret: new FormControl('', Validators.required),
            webhook_enabled: new FormControl(false),
            webhook_url: new FormControl(''),
            webhook_secret: new FormControl('')
        });

        // Initialize from existing value
        if (this.formControl.value) {
            let value = this.formControl.value;
            // If it's a string (which it should be), parse it
            if (typeof value === 'string') {
                try {
                    value = JSON.parse(value);
                } catch (e) { 
                    console.error('Could not parse config', e); 
                    value = {}; 
                }
            }
            this.formGroup.patchValue(value);
            this.webhookEnabled = value.webhook_enabled || false;
        }
        // Watch for webhook_enabled changes
        this.formGroup.get('webhook_enabled')?.valueChanges.subscribe(enabled => {
            this.webhookEnabled = enabled;
            
            // Update validators based on webhook_enabled state
            const webhookUrlControl = this.formGroup.get('webhook_url');
            const webhookSecretControl = this.formGroup.get('webhook_secret');
            
            if (enabled) {
                webhookUrlControl?.setValidators([Validators.required]);
                webhookSecretControl?.setValidators([Validators.required]);
            } else {
                webhookUrlControl?.clearValidators();
                webhookSecretControl?.clearValidators();
                webhookUrlControl?.setValue('');
                webhookSecretControl?.setValue('');
            }
            
            webhookUrlControl?.updateValueAndValidity();
            webhookSecretControl?.updateValueAndValidity();
        });

        // Sync form group changes to formControl
        this.formGroup.valueChanges.subscribe(value => {
            this.formControl.setValue(JSON.stringify(value));
            this.formControl.markAsDirty();
        });

        // Mark as readonly if needed
        if (this.readonly) {
            this.formGroup.disable();
        }
    }
}


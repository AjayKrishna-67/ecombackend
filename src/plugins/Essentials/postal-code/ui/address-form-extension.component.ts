import { Component, OnInit, ViewChild } from '@angular/core';
import { FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { SharedModule } from '@vendure/admin-ui/core';
import { CommonModule } from '@angular/common';
import { PostalCodeInputComponent } from './postal-code-input.component';

/**
 * Component to extend address forms with postal code dropdown
 * This component wraps the postal code input and can be used in address forms
 */
@Component({
  selector: 'postal-code-form-field',
  template: `
    <vdr-form-field [label]="label" [required]="required">
      <postal-code-input
        [formControl]="formControl"
        [placeholder]="placeholder">
      </postal-code-input>
    </vdr-form-field>
  `,
  standalone: true,
  imports: [SharedModule, CommonModule, FormsModule, ReactiveFormsModule, PostalCodeInputComponent],
})
export class PostalCodeFormFieldComponent {
  @ViewChild(PostalCodeInputComponent) postalCodeInput!: PostalCodeInputComponent;
  
  label = 'Postal code';
  placeholder = 'Enter postal code';
  required = false;
  formControl: any;
}



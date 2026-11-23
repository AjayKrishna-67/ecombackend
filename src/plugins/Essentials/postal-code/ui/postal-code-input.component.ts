import { Component, OnInit, forwardRef, ChangeDetectorRef, Output, EventEmitter } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR, FormsModule } from '@angular/forms';
import { SharedModule } from '@vendure/admin-ui/core';
import { Apollo } from 'apollo-angular';
import gql from 'graphql-tag';
import { CommonModule } from '@angular/common';
import { DataService } from '@vendure/admin-ui/core';

const GET_POSTAL_CODES = gql`
  query GetPostalCodes {
    postalCodes {
      id
      code
      isAnywhere
      areas { id name enabled }
    }
  }
`;

interface CachedPostalCode {
  id: string;
  code: string;
  areas: Array<{ id: string; name: string }>;
}

@Component({
  selector: 'postal-code-input',
  template: `
    <div class="postal-code-input-wrapper">
      <!-- Dropdown for custom postal codes -->
      <select
        *ngIf="showDropdown && customPostalCodes.length > 0"
        [(ngModel)]="selectedPostalCode"
        (ngModelChange)="onPostalCodeChange($event)"
        class="postal-code-select"
        [disabled]="disabled">
        <option value="">Select Postal Code</option>
        <option *ngFor="let pc of customPostalCodes" [value]="pc.code">
          {{ pc.code }}
        </option>
      </select>

      <!-- Text input for "anywhere" mode or when no custom codes -->
      <input
        *ngIf="!showDropdown || customPostalCodes.length === 0"
        type="text"
        [(ngModel)]="postalCodeValue"
        (ngModelChange)="onInputChange($event)"
        [placeholder]="placeholder"
        [disabled]="disabled"
        class="postal-code-input"
      />

      <!-- Area dropdown (visible when selected postal code has areas) -->
      <div class="area-field" *ngIf="showDropdown && currentAreas.length > 0">
        <select
          [(ngModel)]="selectedArea"
          (ngModelChange)="onAreaChange($event)"
          class="postal-code-select"
          [disabled]="disabled">
          <option *ngFor="let area of currentAreas" [value]="area.name">
            {{ area.name }}
          </option>
        </select>
      </div>
    </div>
  `,
  styles: [`
    .postal-code-input-wrapper {
      width: 100%;
    }
    .postal-code-select,
    .postal-code-input {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
      box-sizing: border-box;
    }
    .postal-code-select:disabled,
    .postal-code-input:disabled {
      background-color: #f5f5f5;
      cursor: not-allowed;
    }
    .area-field {
      margin-top: 12px;
    }
    .area-label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 4px;
      color: #555;
    }
  `],
  standalone: true,
  imports: [SharedModule, CommonModule, FormsModule],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => PostalCodeInputComponent),
      multi: true
    }
  ]
})
export class PostalCodeInputComponent implements OnInit, ControlValueAccessor {
  customPostalCodes: CachedPostalCode[] = [];
  currentAreas: Array<{ id: string; name: string }> = [];
  showDropdown = false;
  selectedPostalCode = '';
  selectedArea = '';
  postalCodeValue = '';
  disabled = false;
  placeholder = 'Enter postal code';

  @Output() areaSelected = new EventEmitter<string>();

  private onChange = (value: string) => {};
  private onTouched = () => {};

  constructor(
    private apollo: Apollo,
    private dataService: DataService,
    private cdRef: ChangeDetectorRef,
  ) {}

  ngOnInit() {
    this.fetchPostalCodes();
  }

  fetchPostalCodes() {
    this.apollo
      .watchQuery<{ postalCodes: Array<{ id: string; code: string; isAnywhere: boolean; areas: Array<{ id: string; name: string; enabled: boolean }> }> }>({
        query: GET_POSTAL_CODES,
        fetchPolicy: 'network-only',
      })
      .valueChanges.subscribe({
        next: (result) => {
          if (result.data && result.data.postalCodes) {
            const postalCodesFromApi = result.data.postalCodes;
            if (postalCodesFromApi.length === 0) {
              this.showDropdown = false;
              this.customPostalCodes = [];
              this.currentAreas = [];
            } else {
              this.customPostalCodes = postalCodesFromApi.map(pc => ({
                id: pc.id,
                code: pc.code,
                areas: (pc.areas || []).filter(a => a.enabled),
              }));
              this.showDropdown = this.customPostalCodes.length > 0;
              this.updateAreas();
            }
            this.cdRef.detectChanges();
          }
        },
        error: () => {
          this.showDropdown = false;
          this.customPostalCodes = [];
          this.currentAreas = [];
        },
      });
  }

  onPostalCodeChange(value: string) {
    this.postalCodeValue = value;
    this.onChange(value);
    this.updateAreas();
  }

  onInputChange(value: string) {
    this.postalCodeValue = value;
    this.onChange(value);
  }

  onAreaChange(value: string) {
    this.selectedArea = value;
    this.areaSelected.emit(value);
  }

  private updateAreas() {
    const pc = this.customPostalCodes.find(p => p.code === this.selectedPostalCode);
    this.currentAreas = pc?.areas || [];
    if (this.currentAreas.length > 0) {
      this.selectedArea = this.currentAreas[0].name;
      this.areaSelected.emit(this.selectedArea);
    } else {
      this.selectedArea = '';
      this.areaSelected.emit('');
    }
  }

  writeValue(value: string): void {
    this.postalCodeValue = value || '';
    this.selectedPostalCode = value || '';
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }
}

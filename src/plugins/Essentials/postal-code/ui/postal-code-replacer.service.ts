import { Injectable, NgZone } from '@angular/core';
import { Apollo } from 'apollo-angular';
import gql from 'graphql-tag';
import { Subscription } from 'rxjs';

const GET_POSTAL_CODES = gql`
  query GetPostalCodes {
    postalCodes {
      items {
        code
        isAnywhere
        areas { id name }
      }
    }
  }
`;

interface CachedPostalCode {
  code: string;
  areas: Array<{ id: string; name: string }>;
}

/**
 * Globally replaces postal code text inputs with dropdowns and
 * replaces the Area / Landmark custom field with a dependent dropdown.
 *
 * Performance: Only observes structural DOM changes (childList on overlay containers),
 * not attribute changes or text input. Stops scanning once replacements are complete.
 */
@Injectable({
  providedIn: 'root'
})
export class PostalCodeReplacerService {
  private subscription?: Subscription;
  private postalCodes: CachedPostalCode[] = [];
  private dataLoaded = false;
  private observer?: MutationObserver;

  /** All active postal code selects on the page */
  private postalCodeSelects = new Set<HTMLSelectElement>();
  /** Area select → original area input pairs */
  private areaReplacements = new Map<HTMLSelectElement, HTMLInputElement>();

  constructor(
    private apollo: Apollo,
    private ngZone: NgZone
  ) {
    setTimeout(() => this.init(), 1000);
  }

  private init() {
    this.loadPostalCodes();
    this.startObserving();
  }

  /**
   * Only observe the CDK overlay container (where dialogs appear)
   * and direct children of body for new elements.
   * This avoids firing on every keystroke or attribute change.
   */
  private startObserving() {
    let debounceTimer: any;
    this.observer = new MutationObserver((mutations) => {
      // Only react to nodes being ADDED (not text changes, attributes, etc.)
      let hasNewElements = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          hasNewElements = true;
          break;
        }
      }
      if (hasNewElements) {
        // Small debounce to let Angular finish rendering dialog content
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this.ngZone.run(() => this.scanAndReplace());
        }, 150);
      }
    });
    // Observe body for new child elements only (dialogs, overlays)
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false,
    });
  }

  private loadPostalCodes() {
    this.subscription = this.apollo
      .watchQuery<{ postalCodes: { items: any[] } }>({
        query: GET_POSTAL_CODES,
        fetchPolicy: 'cache-first'
      })
      .valueChanges.subscribe({
        next: (result) => {
          if (result.data?.postalCodes) {
            const items = result.data.postalCodes.items || [];
            const anywhereConfig = items.find((pc: any) => pc.isAnywhere);
            if (!anywhereConfig) {
              this.postalCodes = items
                .filter((pc: any) => !pc.isAnywhere)
                .map((pc: any) => ({ code: pc.code, areas: pc.areas || [] }));
              this.dataLoaded = true;
              this.scanAndReplace();
            }
          }
        },
        error: (err) => console.error('[PostalCodeReplacer] Failed to fetch postal codes', err),
      });
  }

  private scanAndReplace() {
    if (!this.dataLoaded || this.postalCodes.length === 0) return;
    this.replacePostalCodeInputs();
    this.replaceAreaInputs();
  }

  // ─── Postal Code ──────────────────────────────────────────────────

  private replacePostalCodeInputs() {
    const inputs = document.querySelectorAll('input[type="text"]:not([data-postal-code-processed]):not([data-exclude-postal-dropdown="true"])');
    inputs.forEach((el) => {
      const input = el as HTMLInputElement;
      if (this.isPostalCodeField(input)) {
        input.setAttribute('data-postal-code-processed', 'true');
        this.replacePostalCodeWithDropdown(input);
      }
    });
  }

  private isPostalCodeField(input: HTMLInputElement): boolean {
    const labelText = this.getLabelText(input);
    const fcName = this.getFormControlName(input);
    const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
    return (
      fcName === 'postalCode' || fcName.includes('postal') ||
      labelText.includes('postal') || labelText.includes('post code') ||
      placeholder.includes('postal') || placeholder.includes('post code')
    );
  }

  private replacePostalCodeWithDropdown(input: HTMLInputElement) {
    const parent = input.parentElement;
    if (!parent) return;
    const currentValue = input.value;

    const select = document.createElement('select');
    select.className = input.className;
    select.style.width = '100%';
    if (input.disabled) select.disabled = true;
    if (input.required) select.required = true;

    this.postalCodes.forEach(pc => {
      const option = document.createElement('option');
      option.value = pc.code;
      option.textContent = pc.code;
      if (currentValue === pc.code) option.selected = true;
      select.appendChild(option);
    });

    if (currentValue && this.postalCodes.some(pc => pc.code === currentValue)) {
      select.value = currentValue;
    } else if (this.postalCodes.length > 0) {
      select.value = this.postalCodes[0].code;
      input.value = this.postalCodes[0].code;
    }

    select.addEventListener('change', () => {
      input.value = select.value;
      input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      this.updateAreaDropdowns(select);
    });

    parent.insertBefore(select, input);
    input.style.display = 'none';
    input.setAttribute('data-replaced-by-dropdown', 'true');
    this.postalCodeSelects.add(select);
  }

  // ─── Area ─────────────────────────────────────────────────────────

  private replaceAreaInputs() {
    const allFormFields = document.querySelectorAll('vdr-form-field, vdr-custom-field-control');
    allFormFields.forEach((field) => {
      const label = field.querySelector('label');
      if (!label) return;
      const labelText = (label.textContent || '').toLowerCase().trim();
      if (!labelText.includes('area') && !labelText.includes('landmark')) return;
      const input = field.querySelector('input[type="text"]:not([data-area-replaced])') as HTMLInputElement;
      if (!input) return;
      this.replaceAreaWithDropdown(input);
    });
  }

  private replaceAreaWithDropdown(input: HTMLInputElement) {
    const parent = input.parentElement;
    if (!parent) return;

    const areaSelect = document.createElement('select');
    areaSelect.className = input.className;
    areaSelect.style.width = '100%';

    areaSelect.addEventListener('change', () => {
      input.value = areaSelect.value;
      input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    });

    parent.insertBefore(areaSelect, input);
    input.style.display = 'none';
    input.setAttribute('data-area-replaced', 'true');
    this.areaReplacements.set(areaSelect, input);

    const postalCodeSelect = this.findPostalCodeSelectInSameForm(areaSelect);
    if (postalCodeSelect) {
      this.populateAreaDropdown(areaSelect, input, postalCodeSelect.value);
    }
  }

  private findPostalCodeSelectInSameForm(areaElement: HTMLElement): HTMLSelectElement | null {
    const form = areaElement.closest('form, vdr-address-form, vdr-card');
    if (!form) return null;
    for (const pcSelect of this.postalCodeSelects) {
      if (form.contains(pcSelect)) return pcSelect;
    }
    return null;
  }

  private updateAreaDropdowns(postalCodeSelect: HTMLSelectElement) {
    const form = postalCodeSelect.closest('form, vdr-address-form, vdr-card');
    if (!form) return;
    for (const [areaSelect, areaInput] of this.areaReplacements) {
      if (form.contains(areaSelect)) {
        this.populateAreaDropdown(areaSelect, areaInput, postalCodeSelect.value);
      }
    }
  }

  private populateAreaDropdown(areaSelect: HTMLSelectElement, areaInput: HTMLInputElement, postalCode: string) {
    const pc = this.postalCodes.find(p => p.code === postalCode);
    const areas = pc?.areas || [];
    const currentVal = areaSelect.value || areaInput.value;
    areaSelect.innerHTML = '';

    if (areas.length === 0) {
      areaSelect.style.display = 'none';
      areaInput.style.display = '';
      return;
    }

    areaSelect.style.display = '';
    areaInput.style.display = 'none';

    areas.forEach(area => {
      const option = document.createElement('option');
      option.value = area.name;
      option.textContent = area.name;
      if (currentVal === area.name) option.selected = true;
      areaSelect.appendChild(option);
    });

    if (!areas.find(a => a.name === currentVal) && areas.length > 0) {
      areaSelect.value = areas[0].name;
    }

    areaInput.value = areaSelect.value;
    areaInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  }

  // ─── Utils ────────────────────────────────────────────────────────

  private getLabelText(input: HTMLInputElement): string {
    const field = input.closest('vdr-form-field, vdr-custom-field-control, .form-field, .form-group');
    if (field) {
      const label = field.querySelector('label');
      if (label) return (label.textContent || '').toLowerCase().trim();
    }
    return '';
  }

  private getFormControlName(input: HTMLInputElement): string {
    return (
      input.getAttribute('formControlName') ||
      input.getAttribute('ng-reflect-name') ||
      input.getAttribute('name') ||
      ''
    );
  }

  ngOnDestroy() {
    if (this.subscription) this.subscription.unsubscribe();
    if (this.observer) this.observer.disconnect();
    this.postalCodeSelects.clear();
    this.areaReplacements.clear();
  }
}

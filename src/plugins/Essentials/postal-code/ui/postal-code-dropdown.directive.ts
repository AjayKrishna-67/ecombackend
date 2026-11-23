import { Directive, ElementRef, OnInit, AfterViewInit, Input, Renderer2, OnDestroy, NgZone } from '@angular/core';
import { ControlContainer } from '@angular/forms';
import { Apollo } from 'apollo-angular';
import gql from 'graphql-tag';
import { Subscription } from 'rxjs';

const GET_POSTAL_CODES = gql`
  query GetPostalCodes {
    postalCodes {
      items {
        id
        code
        isAnywhere
        areas { id name enabled }
      }
      totalItems
    }
  }
`;

interface CachedPostalCode {
  code: string;
  areas: Array<{ id: string; name: string }>;
}

@Directive({
  standalone: false,
  selector: 'input[type="text"]',
})
export class PostalCodeDropdownDirective implements OnInit, AfterViewInit, OnDestroy {
  @Input() formControlName?: string;
  @Input() name?: string;

  private originalInput?: HTMLInputElement;
  private selectElement?: HTMLSelectElement;
  private areaSelectElement?: HTMLSelectElement;
  private areaOriginalInput?: HTMLInputElement;
  private subscription?: Subscription;
  private postalCodes: CachedPostalCode[] = [];
  private hasProcessed = false;
  private observer?: MutationObserver;
  private checkInterval?: any;

  constructor(
    private el: ElementRef<HTMLInputElement>,
    private renderer: Renderer2,
    private apollo: Apollo,
    private controlContainer: ControlContainer,
    private ngZone: NgZone,
  ) {}

  ngOnInit() {
    const input = this.el.nativeElement;
    if (this.isPostalCodeField(input) && !this.hasProcessed) {
      this.originalInput = input;
      this.hasProcessed = true;
      setTimeout(() => {
        if (this.originalInput && !this.selectElement) {
          this.fetchPostalCodes();
        }
      }, 500);
    }
  }

  ngAfterViewInit() {
    if (!this.originalInput && !this.hasProcessed) {
      this.checkIfPostalCodeField();
    }
    this.ngZone.runOutsideAngular(() => {
      const parent = this.el.nativeElement.parentElement;
      if (parent) {
        this.observer = new MutationObserver(() => {
          if (!this.hasProcessed) {
            this.ngZone.run(() => this.checkIfPostalCodeField());
          }
        });
        this.observer.observe(parent, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id', 'name'] });
      }
    });
    this.checkInterval = setInterval(() => {
      if (!this.hasProcessed && !this.originalInput) {
        this.checkIfPostalCodeField();
      } else if (this.hasProcessed) {
        clearInterval(this.checkInterval);
      }
    }, 1000);
    setTimeout(() => { if (this.checkInterval) clearInterval(this.checkInterval); }, 10000);
  }

  private isPostalCodeField(input: HTMLInputElement): boolean {
    if (input.getAttribute('data-exclude-postal-dropdown') === 'true') return false;
    const name = input.getAttribute('name') || '';
    const id = input.getAttribute('id') || '';
    const formControlName = input.getAttribute('formControlName') || input.getAttribute('ng-reflect-name') || '';
    const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
    const parent = input.closest('vdr-form-field, .form-field, form-field, .form-group, [class*="form"], [class*="field"]');
    let labelText = '';
    if (parent) {
      const label = parent.querySelector('label, .label, [class*="label"], vdr-form-field-label');
      if (label) {
        labelText = (label.textContent || (label as HTMLElement).innerText || '').toLowerCase().trim();
      }
    }
    return (
      (this.formControlName === 'postalCode') ||
      (this.name === 'postalCode') ||
      (formControlName === 'postalCode' || formControlName.includes('postalCode') || formControlName.includes('postal')) ||
      (name.toLowerCase().includes('postal') || name.toLowerCase().includes('postcode')) ||
      (id.toLowerCase().includes('postal') || id.toLowerCase().includes('postcode')) ||
      (placeholder.includes('postal') || placeholder.includes('post code')) ||
      (labelText.includes('postal') || labelText.includes('post code'))
    );
  }

  private checkIfPostalCodeField() {
    if (this.hasProcessed) return;
    const input = this.el.nativeElement;
    if (this.isPostalCodeField(input)) {
      this.originalInput = input;
      this.hasProcessed = true;
      if (this.checkInterval) clearInterval(this.checkInterval);
      if (this.observer) this.observer.disconnect();
      setTimeout(() => {
        if (this.originalInput && !this.selectElement) {
          this.fetchPostalCodes();
        }
      }, 500);
    }
  }

  /**
   * Finds the Area / Landmark custom field input within the same form.
   */
  private findAreaInput(): HTMLInputElement | null {
    if (!this.originalInput) return null;
    // Search broadly: form, card, or dialog that contains the postal code input
    const container = this.originalInput.closest('form, vdr-address-form, vdr-card, .cdk-overlay-pane');
    if (!container) return null;

    // Find by label text "area" or "landmark" — works in production builds
    const allFields = container.querySelectorAll('vdr-form-field, vdr-custom-field-control');
    for (const field of Array.from(allFields)) {
      const label = field.querySelector('label');
      const labelText = (label?.textContent || '').toLowerCase().trim();
      if (labelText.includes('area') || labelText.includes('landmark')) {
        const input = field.querySelector('input[type="text"]') as HTMLInputElement;
        if (input && !input.hasAttribute('data-area-replaced')) return input;
      }
    }
    return null;
  }

  fetchPostalCodes() {
    this.subscription = this.apollo
      .watchQuery<{ postalCodes: { items: any[] } }>({
        query: GET_POSTAL_CODES,
        fetchPolicy: 'network-only',
      })
      .valueChanges.subscribe({
        next: (result) => {
          if (result.data && result.data.postalCodes) {
            const items = result.data.postalCodes.items || [];
            const anywhereConfig = items.find(pc => pc.isAnywhere);
            if (anywhereConfig) {
              this.restoreAll();
            } else {
              this.postalCodes = items
                .filter(pc => !pc.isAnywhere)
                .map(pc => ({ code: pc.code, areas: (pc.areas || []).filter(a => a.enabled) }));
              if (this.postalCodes.length > 0) {
                this.replaceWithDropdown();
              } else {
                this.restoreAll();
              }
            }
          }
        },
        error: () => this.restoreAll(),
      });
  }

  replaceWithDropdown() {
    if (!this.originalInput || this.selectElement) return;
    const input = this.originalInput;
    const parent = input.parentElement;
    if (!parent) return;
    const currentValue = input.value;
    const isDisabled = input.disabled;
    const isRequired = input.required;
    const formControlName = input.getAttribute('formControlName') || input.getAttribute('ng-reflect-name') || 'postalCode';

    // Angular form control
    let formControl: any = null;
    if (this.controlContainer) {
      const form = (this.controlContainer as any).control || (this.controlContainer as any).form;
      if (form?.get) formControl = form.get(formControlName);
    }

    // Create postal code select
    this.selectElement = this.renderer.createElement('select');
    this.renderer.setAttribute(this.selectElement, 'class', input.className || '');
    this.renderer.setAttribute(this.selectElement, 'id', input.id || '');
    this.renderer.setAttribute(this.selectElement, 'name', input.name || 'postalCode');
    this.renderer.setAttribute(this.selectElement, 'formControlName', formControlName);
    if (isDisabled) this.renderer.setAttribute(this.selectElement, 'disabled', 'true');
    if (isRequired) this.renderer.setAttribute(this.selectElement, 'required', 'true');

    const emptyOption = this.renderer.createElement('option');
    this.renderer.setAttribute(emptyOption, 'value', '');
    this.renderer.appendChild(emptyOption, this.renderer.createText('Select Postal Code'));
    this.renderer.appendChild(this.selectElement, emptyOption);

    this.postalCodes.forEach(pc => {
      const option = this.renderer.createElement('option');
      this.renderer.setAttribute(option, 'value', pc.code);
      this.renderer.appendChild(option, this.renderer.createText(pc.code));
      if (currentValue === pc.code) this.renderer.setAttribute(option, 'selected', 'true');
      this.renderer.appendChild(this.selectElement, option);
    });

    if (currentValue && this.selectElement) this.selectElement.value = currentValue;

    // Postal code change handler
    if (this.selectElement && this.originalInput) {
      this.selectElement.addEventListener('change', (e: any) => {
        const value = e.target.value;
        if (this.originalInput) {
          this.originalInput.value = value;
          if (formControl) {
            formControl.setValue(value, { emitEvent: true });
            formControl.markAsTouched();
            formControl.markAsDirty();
          }
          this.originalInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          this.originalInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        }
        this.updateAreaDropdown(value);
      });
    }

    this.renderer.insertBefore(parent, this.selectElement, input);
    this.renderer.setStyle(input, 'display', 'none');
    this.renderer.setAttribute(input, 'data-replaced-by-dropdown', 'true');
    this.renderer.setAttribute(input, 'tabindex', '-1');

    // Replace the area custom field input after Angular finishes rendering
    setTimeout(() => {
      this.replaceAreaField();
      this.updateAreaDropdown(this.selectElement?.value || currentValue);
    }, 800);
    // Retry in case custom fields section loads late
    setTimeout(() => {
      if (!this.areaOriginalInput) {
        this.replaceAreaField();
        this.updateAreaDropdown(this.selectElement?.value || currentValue);
      }
    }, 2000);
  }

  /**
   * Finds the Vendure-rendered Area / Landmark custom field text input
   * and replaces it with a select dropdown.
   */
  private replaceAreaField() {
    if (this.areaOriginalInput) return; // Already replaced
    const areaInput = this.findAreaInput();
    if (!areaInput) return;
    this.areaOriginalInput = areaInput;
    const areaParent = areaInput.parentElement;
    if (!areaParent) return;

    const areaSelect: HTMLSelectElement = this.renderer.createElement('select');
    this.areaSelectElement = areaSelect;
    this.renderer.setAttribute(areaSelect, 'class', areaInput.className || '');
    this.renderer.setStyle(areaSelect, 'width', '100%');

    // Sync changes back to the original input (triggers Angular's formControl update)
    areaSelect.addEventListener('change', () => {
      if (this.areaOriginalInput) {
        this.areaOriginalInput.value = areaSelect.value;
        this.areaOriginalInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        this.areaOriginalInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      }
    });

    this.renderer.insertBefore(areaParent, areaSelect, areaInput);
    this.renderer.setStyle(areaInput, 'display', 'none');
    this.renderer.setAttribute(areaInput, 'data-area-replaced', 'true');
  }

  /**
   * Updates area dropdown options based on the selected postal code.
   * Hides the area field container if no areas are defined.
   */
  private updateAreaDropdown(postalCode: string) {
    if (!this.areaSelectElement) return;
    const pc = this.postalCodes.find(p => p.code === postalCode);
    const areas = pc?.areas || [];
    const currentVal = this.areaSelectElement.value;
    this.areaSelectElement.innerHTML = '';
    const areaFieldContainer = this.areaSelectElement.closest('vdr-custom-field-control, vdr-form-field');

    if (areas.length === 0) {
      // No areas → show original text input, hide dropdown
      if (this.areaSelectElement) this.renderer.setStyle(this.areaSelectElement, 'display', 'none');
      if (this.areaOriginalInput) {
        this.renderer.removeStyle(this.areaOriginalInput, 'display');
      }
      if (areaFieldContainer) (areaFieldContainer as HTMLElement).style.display = '';
      return;
    }

    // Has areas → show dropdown, hide original text input
    if (this.areaSelectElement) this.renderer.removeStyle(this.areaSelectElement, 'display');
    if (this.areaOriginalInput) this.renderer.setStyle(this.areaOriginalInput, 'display', 'none');
    if (areaFieldContainer) (areaFieldContainer as HTMLElement).style.display = '';
    areas.forEach(area => {
      const option = this.renderer.createElement('option');
      this.renderer.setAttribute(option, 'value', area.name);
      this.renderer.appendChild(option, this.renderer.createText(area.name));
      if (currentVal === area.name) this.renderer.setAttribute(option, 'selected', 'true');
      this.areaSelectElement!.appendChild(option);
    });

    if (!areas.find(a => a.name === currentVal) && areas.length > 0) {
      this.areaSelectElement.value = areas[0].name;
    }
    this.areaSelectElement.dispatchEvent(new Event('change', { bubbles: true }));
  }

  private restoreAll() {
    // Restore postal code input
    if (this.selectElement && this.originalInput) {
      const parent = this.selectElement.parentElement;
      if (parent) this.renderer.removeChild(parent, this.selectElement);
      this.renderer.removeStyle(this.originalInput, 'display');
      this.renderer.removeAttribute(this.originalInput, 'data-replaced-by-dropdown');
      this.selectElement = undefined;
    }
    // Restore area input
    if (this.areaSelectElement && this.areaOriginalInput) {
      const parent = this.areaSelectElement.parentElement;
      if (parent) this.renderer.removeChild(parent, this.areaSelectElement);
      this.renderer.removeStyle(this.areaOriginalInput, 'display');
      this.renderer.removeAttribute(this.areaOriginalInput, 'data-area-replaced');
      this.areaSelectElement = undefined;
      this.areaOriginalInput = undefined;
    }
  }

  ngOnDestroy() {
    if (this.subscription) this.subscription.unsubscribe();
    if (this.observer) this.observer.disconnect();
    if (this.checkInterval) clearInterval(this.checkInterval);
    this.restoreAll();
  }
}

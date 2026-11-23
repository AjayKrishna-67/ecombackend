import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule, FormsModule } from '@angular/forms';
import { SharedModule } from '@vendure/admin-ui/core';
import { Apollo } from 'apollo-angular';
import gql from 'graphql-tag';
import { CommonModule } from '@angular/common';
import { DataService } from '@vendure/admin-ui/core';

const GET_POSTAL_CODES = gql`
  query GetPostalCodes {
    postalCodes {
      items {
        id
        code
        isAnywhere
      }
      totalItems
    }
  }
`;

const CREATE_POSTAL_CODE = gql`
  mutation CreatePostalCode($input: CreatePostalCodeInput!) {
    createPostalCode(input: $input) {
      id
      code
      isAnywhere
    }
  }
`;

const UPDATE_POSTAL_CODE = gql`
  mutation UpdatePostalCode($input: UpdatePostalCodeInput!) {
    updatePostalCode(input: $input) {
      id
      code
      isAnywhere
    }
  }
`;

const DELETE_POSTAL_CODE = gql`
  mutation DeletePostalCode($id: ID!) {
    deletePostalCode(id: $id) {
      result
    }
  }
`;

@Component({
  selector: 'postal-code-management',
  template: `
    <vdr-page-block>
      <vdr-card>
        <div class="header-section">
          <h2>Postal Code Configuration</h2>
          <p class="description">Configure postal code settings for the current channel</p>
        </div>

        <!-- Configuration Options -->
        <div class="config-section">
          <vdr-form-field label="Postal Code Type">
            <select 
              [(ngModel)]="selectedOption"
              (change)="onOptionChange()"
              class="form-control mode-dropdown">
              <option value="anywhere">Anywhere</option>
              <option value="custom">Custom</option>
            </select>
          </vdr-form-field>

          <!-- Anywhere Option -->
          <div *ngIf="selectedOption === 'anywhere'" class="anywhere-section">
            <div class="info-alert">
              <strong>Anywhere Mode:</strong> This allows any postal code to be used. 
              You can enter a placeholder postal code below.
            </div>
            <vdr-form-field label="Postal Code (Optional)">
              <input 
                type="text" 
                [(ngModel)]="anywhereCode" 
                placeholder="e.g., ANY"
                class="form-control"
              />
            </vdr-form-field>
            <button 
              vdr-button 
              type="button" 
              color="primary"
              [disabled]="!canCreatePostalCode || (isAnywhereConfigured && selectedOption === 'anywhere')"
              (click)="saveAnywhere()"
              class="save-btn">
              {{ (isAnywhereConfigured && selectedOption === 'anywhere') ? 'Already Configured' : 'Save Anywhere Configuration' }}
            </button>
          </div>

          <!-- Custom Option -->
          <div *ngIf="selectedOption === 'custom'" class="custom-section">
            <div class="info-alert">
              <strong>Custom Mode:</strong> Add specific postal codes that are allowed. Select from existing codes or add new ones.
            </div>
            
            <!-- Save Custom Configuration Button -->
            <button 
              vdr-button 
              type="button" 
              color="primary"
              [disabled]="!canCreatePostalCode || (isCustomConfigured && selectedOption === 'custom')"
              (click)="saveCustom()"
              class="save-btn">
              {{ (isCustomConfigured && selectedOption === 'custom') ? 'Already Configured' : (customPostalCodes.length > 0 ? 'Save Custom Configuration' : 'Activate Custom Mode') }}
            </button>
            
            <!-- Search Postal Code -->
            <div class="search-section">
              <vdr-form-field label="Search by Postal Code">
                <input 
                  type="text" 
                  [(ngModel)]="searchPostalCode" 
                  (input)="onSearchChange()"
                  (focus)="onSearchFocus($event)"
                  placeholder="Search postal codes..."
                  class="form-control postal-code-input"
                  autocomplete="chrome-off"
                  list=""
                  id="search-postal-code-input"
                  name="search-postal-code-field"
                  role="textbox"
                  aria-autocomplete="none"
                  spellcheck="false"
                  data-exclude-postal-dropdown="true"
                  [attr.readonly]="true"
                />
              </vdr-form-field>
            </div>
            
            <!-- Add New Postal Code Form -->
            <div class="add-form" *ngIf="canCreatePostalCode">
              <vdr-form-field label="Add New Postal Code">
                <input 
                  type="text" 
                  [(ngModel)]="newPostalCode" 
                  (input)="onAddPostalCodeInput($event)"
                  (focus)="onAddFocus($event)"
                  placeholder="Enter postal code (numbers only)"
                  class="form-control postal-code-input"
                  autocomplete="chrome-off"
                  list=""
                  id="add-postal-code-input"
                  name="add-postal-code-field"
                  pattern="[0-9]*"
                  role="textbox"
                  aria-autocomplete="none"
                  spellcheck="false"
                  data-exclude-postal-dropdown="true"
                  [attr.readonly]="true"
                  (keyup.enter)="addPostalCode()"
                />
                <div *ngIf="duplicateError" class="error-message">
                  {{ duplicateError }}
                </div>
              </vdr-form-field>
              <button 
                vdr-button 
                type="button" 
                color="primary"
                [disabled]="!newPostalCode || newPostalCode.trim() === '' || duplicateError"
                (click)="addPostalCode()"
                class="add-btn">
                Add Postal Code
              </button>
            </div>

            <!-- Show count and list of postal codes -->
            <div class="postal-codes-section" *ngIf="customPostalCodes.length > 0">
              <div class="postal-codes-info">
                <p class="info-text">Total Custom Postal Codes: {{ customPostalCodes.length }}</p>
              </div>
              
              <!-- List of Postal Codes with Edit/Delete -->
              <div class="postal-codes-list">
                <div class="postal-code-item" *ngFor="let postalCode of filteredPostalCodes">
                  <div class="code-display">
                    <span class="code-value">{{ postalCode.code }}</span>
                  </div>
                  <div class="actions" *ngIf="canUpdatePostalCode || canDeletePostalCode">
                    <button 
                      *ngIf="canUpdatePostalCode"
                      vdr-button 
                      type="button" 
                      size="small"
                      (click)="editPostalCode(postalCode)"
                      class="edit-btn">
                      Edit
                    </button>
                    <button 
                      *ngIf="canDeletePostalCode"
                      vdr-button 
                      type="button" 
                      size="small"
                      color="danger"
                      (click)="deletePostalCode(postalCode.id)"
                      class="delete-btn">
                      Delete
                    </button>
                  </div>
                </div>
              </div>
              
              <div *ngIf="filteredPostalCodes.length === 0 && searchPostalCode" class="no-results">
                <p>No postal codes found matching "{{ searchPostalCode }}"</p>
              </div>
            </div>
            
            <div *ngIf="customPostalCodes.length === 0" class="empty-state">
              <p>No custom postal codes added yet. Add one above to get started.</p>
            </div>
          </div>
        </div>
      </vdr-card>

      <!-- Edit Modal -->
      <div *ngIf="editingPostalCode" class="modal-overlay" (click)="cancelEdit()">
        <div class="modal-content" (click)="$event.stopPropagation()">
          <div class="modal-header">
            <h3>Edit Postal Code</h3>
            <button class="close-btn" (click)="cancelEdit()">&times;</button>
          </div>
          <div class="edit-form">
            <vdr-form-field label="Postal Code">
              <input 
                type="text" 
                [(ngModel)]="editCode" 
                (input)="onEditPostalCodeInput($event)"
                placeholder="Enter postal code (numbers only)"
                class="form-control postal-code-input"
                autocomplete="new-password"
                list=""
                pattern="[0-9]*"
                role="textbox"
                aria-autocomplete="none"
                spellcheck="false"
                data-exclude-postal-dropdown="true"
              />
            </vdr-form-field>
            <div class="modal-actions">
              <button 
                vdr-button 
                type="button" 
                (click)="cancelEdit()"
                class="cancel-btn">
                Cancel
              </button>
              <button 
                vdr-button 
                type="button" 
                color="primary"
                [disabled]="!editCode || editCode.trim() === ''"
                (click)="saveEdit()"
                class="save-btn">
                Save
              </button>
            </div>
          </div>
        </div>
      </div>
    </vdr-page-block>
  `,
  styles: [`
    .header-section {
      margin-bottom: 24px;
    }

    .header-section h2 {
      margin: 0 0 8px 0;
      font-size: 24px;
      font-weight: 600;
    }

    .description {
      color: #666;
      margin: 0;
    }

    .config-section {
      margin-top: 24px;
    }

    .anywhere-section,
    .custom-section {
      margin-top: 16px;
      padding: 16px;
      background: #f9f9f9;
      border-radius: 8px;
    }

    .form-control {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }

    .postal-code-input {
      -webkit-appearance: none !important;
      -moz-appearance: none !important;
      appearance: none !important;
      background-image: none !important;
      background-color: white !important;
    }

    .postal-code-input::-webkit-calendar-picker-indicator {
      display: none !important;
      opacity: 0 !important;
      pointer-events: none !important;
      position: absolute !important;
      right: -9999px !important;
    }

    .postal-code-input::-webkit-list-button {
      display: none !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }

    .postal-code-input::-webkit-dropdown-arrow {
      display: none !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }

    .postal-code-input::-webkit-inner-spin-button,
    .postal-code-input::-webkit-outer-spin-button {
      display: none !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }

    /* Hide any datalist dropdown */
    .postal-code-input[list]::-webkit-calendar-picker-indicator {
      display: none !important;
    }

    /* Force remove any dropdown styling */
    input.postal-code-input[type="text"] {
      -webkit-appearance: textfield !important;
      -moz-appearance: textfield !important;
      appearance: textfield !important;
    }

    .save-btn,
    .add-btn {
      margin-top: 12px;
    }

    .add-form {
      display: flex;
      gap: 12px;
      align-items: flex-end;
      margin-bottom: 24px;
    }

    .add-form vdr-form-field {
      flex: 1;
    }

    .postal-codes-section {
      margin-top: 24px;
    }

    .postal-codes-info {
      margin-bottom: 16px;
      padding: 12px;
      background: #f0f0f0;
      border-radius: 4px;
    }

    .info-text {
      margin: 0;
      font-size: 14px;
      color: #666;
      font-weight: 500;
    }

    .postal-codes-list {
      margin-top: 16px;
    }

    .postal-code-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: white;
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      margin-bottom: 8px;
    }

    .code-display {
      flex: 1;
    }

    .code-value {
      font-size: 16px;
      font-weight: 500;
      color: #333;
    }

    .actions {
      display: flex;
      gap: 8px;
    }

    .edit-btn {
      background: #007bff;
      color: white;
    }

    .delete-btn {
      background: #dc3545;
      color: white;
    }

    .search-section {
      margin-top: 16px;
      margin-bottom: 16px;
    }

    .error-message {
      color: #dc3545;
      font-size: 12px;
      margin-top: 4px;
      padding: 4px 8px;
      background: #ffe6e6;
      border-radius: 4px;
    }

    .no-results {
      text-align: center;
      padding: 24px;
      color: #999;
      font-style: italic;
    }

    .empty-state {
      text-align: center;
      padding: 32px;
      color: #999;
    }

    .edit-form {
      padding: 16px;
    }

    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      margin-top: 16px;
    }

    .cancel-btn {
      background: #6c757d;
      color: white;
    }

    .mode-dropdown {
      width: 100%;
      max-width: 300px;
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }

    .info-alert {
      padding: 12px 16px;
      background: #e3f2fd;
      border-left: 4px solid #2196f3;
      border-radius: 4px;
      margin-bottom: 16px;
      color: #1976d2;
    }

    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .modal-content {
      background: white;
      border-radius: 8px;
      width: 90%;
      max-width: 500px;
      max-height: 90vh;
      overflow-y: auto;
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 24px;
      border-bottom: 1px solid #e0e0e0;
    }

    .modal-header h3 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
    }

    .close-btn {
      background: none;
      border: none;
      font-size: 28px;
      cursor: pointer;
      color: #666;
      padding: 0;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .close-btn:hover {
      color: #000;
    }

  `],
  standalone: true,
  imports: [SharedModule, CommonModule, ReactiveFormsModule, FormsModule],
})
export class PostalCodeComponent implements OnInit {
  postalCodes: Array<{ id: string; code: string; isAnywhere: boolean }> = [];
  customPostalCodes: Array<{ id: string; code: string }> = [];
  filteredPostalCodes: Array<{ id: string; code: string }> = [];
  selectedOption: 'anywhere' | 'custom' = 'custom';
  isInitialLoad: boolean = true;
  newPostalCode: string = '';
  searchPostalCode: string = '';
  duplicateError: string = '';
  anywhereCode: string = 'ANY';
  editingPostalCode: { id: string; code: string } | null = null;
  editCode: string = '';
  currentChannelId: string | null = null;
  isAnywhereConfigured: boolean = false;
  isCustomConfigured: boolean = false;
  selectedPostalCodeForCrud: string = '';

  canCreatePostalCode = false;
  canUpdatePostalCode = false;
  canDeletePostalCode = false;

  constructor(
    private apollo: Apollo,
    private dataService: DataService,
    private cdRef: ChangeDetectorRef
  ) {}

  ngOnInit() {
    this.checkPermissions();
    this.fetchActiveChannel();
  }

  checkPermissions() {
    this.dataService
      .query<{ me: { channels: Array<{ permissions: string[] }> } }>(
        gql`
          query GetCurrentUserPermissions {
            me {
              channels {
                permissions
              }
            }
          }
        `
      )
      .single$.subscribe({
        next: (response) => {
          const permissions = response.me.channels?.[0]?.permissions || [];
          this.canCreatePostalCode = permissions.includes('CreatePostalCode') || permissions.includes('SuperAdmin');
          this.canUpdatePostalCode = permissions.includes('UpdatePostalCode') || permissions.includes('SuperAdmin');
          this.canDeletePostalCode = permissions.includes('DeletePostalCode') || permissions.includes('SuperAdmin');
          this.cdRef.detectChanges();
        },
        error: (err) => console.error('Failed to fetch user permissions', err),
      });
  }

  fetchActiveChannel() {
    this.dataService
      .query<{ activeChannel: { id: string } }>(
        gql`
          query GetActiveChannel {
            activeChannel {
              id
            }
          }
        `
      )
      .single$.subscribe({
        next: (response) => {
          this.currentChannelId = response.activeChannel.id;
          this.fetchPostalCodes();
        },
        error: (err) => console.error('Failed to fetch active channel', err),
      });
  }

  fetchPostalCodes() {
    this.apollo
      .watchQuery<{ postalCodes: { items: any[] } }>({
        query: GET_POSTAL_CODES,
        fetchPolicy: 'network-only'
      })
      .valueChanges.subscribe({
        next: (result) => {
          if (result.data && result.data.postalCodes) {
            // Postal codes are already filtered by channel on the backend
            this.postalCodes = result.data.postalCodes.items || [];

            // Check if "Anywhere" is configured
            const anywhereConfig = this.postalCodes.find(pc => pc.isAnywhere);
            this.isAnywhereConfigured = !!anywhereConfig;
            
            // Filter custom postal codes (always update the list)
            this.customPostalCodes = this.postalCodes
              .filter(pc => !pc.isAnywhere)
              .map(pc => ({ id: pc.id, code: pc.code }));
            
            // Check if custom mode is configured (has custom postal codes)
            // Custom is only considered "configured" if it has postal codes AND anywhere is NOT configured
            // This prevents showing "Already Configured" when anywhere is active
            this.isCustomConfigured = this.customPostalCodes.length > 0 && !this.isAnywhereConfigured;
            
            // On initial page load/refresh, set the correct mode based on what's configured
            // Priority: Anywhere mode if configured, otherwise custom if has postal codes
            // Only set on initial load, not when user manually changes dropdown
            if (this.isInitialLoad) {
              if (anywhereConfig) {
                // If anywhere is configured, show anywhere mode (has priority)
                this.anywhereCode = anywhereConfig.code;
                this.selectedOption = 'anywhere';
              } else if (this.isCustomConfigured) {
                // If custom postal codes exist and no anywhere, show custom mode
                this.selectedOption = 'custom';
              } else {
                // Default to custom if nothing is configured
                this.selectedOption = 'custom';
              }
              this.isInitialLoad = false;
            } else {
              // On subsequent fetches (not initial load), preserve user's selection
              // Just update the anywhere code if it exists
              if (anywhereConfig) {
                this.anywhereCode = anywhereConfig.code;
              }
            }
            
            // Apply search filter
            this.applySearchFilter();
            
            // Check for duplicate when adding new postal code
            this.checkDuplicate();

            this.cdRef.detectChanges();
          }
        },
        error: (err) => {
          console.error('Failed to fetch postal codes', err);
          // Show user-friendly error
          if (err.graphQLErrors && err.graphQLErrors.length > 0) {
            console.error('GraphQL Errors:', err.graphQLErrors);
          }
        },
      });
  }

  onOptionChange() {
    // When switching to custom, just refresh to show custom postal codes
    // Don't delete "anywhere" yet - only delete when saving in custom mode
    if (this.selectedOption === 'custom') {
      this.fetchPostalCodes();
    } else if (this.selectedOption === 'anywhere') {
      // When switching to anywhere, refresh to show anywhere config
      this.fetchPostalCodes();
    }
  }

  saveAnywhere() {
    if (!this.anywhereCode || this.anywhereCode.trim() === '') {
      this.anywhereCode = 'ANY';
    }

    // Always fetch fresh data to ensure we have the latest state
    // This is important because when in "custom" mode, the "anywhere" record
    // might not be in the current postalCodes array
    this.apollo.query<{ postalCodes: { items: any[] } }>({
      query: GET_POSTAL_CODES,
      fetchPolicy: 'network-only'
    }).subscribe({
      next: (result) => {
        if (result.data && result.data.postalCodes) {
          const allPostalCodes = result.data.postalCodes.items || [];
          // Look for existing "anywhere" record in the current channel
          const existingAnywhere = allPostalCodes.find(pc => pc.isAnywhere);
          
          console.log('Checking for existing anywhere:', {
            totalPostalCodes: allPostalCodes.length,
            existingAnywhere: existingAnywhere ? { id: existingAnywhere.id, code: existingAnywhere.code } : null
          });
          
          this.processAnywhereSave(existingAnywhere);
        } else {
          // No data, create new
          console.log('No postal codes found, creating new anywhere');
          this.processAnywhereSave(null);
        }
      },
      error: (err) => {
        console.error('Failed to fetch postal codes for anywhere check', err);
        // On error, check current array as fallback
        const existingAnywhere = this.postalCodes.find(pc => pc.isAnywhere);
        this.processAnywhereSave(existingAnywhere);
      }
    });
  }

  private processAnywhereSave(existingAnywhere: any) {
    // DON'T delete custom postal codes - keep them in database
    // Shop API will handle showing only "anywhere" when it exists
    
    if (existingAnywhere) {
      // Update existing "anywhere" configuration (don't create new one)
      console.log('Updating existing anywhere configuration, ID:', existingAnywhere.id);
      this.apollo.mutate({
        mutation: UPDATE_POSTAL_CODE,
        variables: {
          input: {
            id: existingAnywhere.id,
            code: this.anywhereCode.trim(),
            isAnywhere: true
          }
        },
        refetchQueries: [{ query: GET_POSTAL_CODES }]
      }).subscribe({
        next: () => {
          this.selectedOption = 'anywhere';
          this.isAnywhereConfigured = true;
          this.fetchPostalCodes();
        },
        error: (err) => {
          console.error('Failed to update anywhere configuration', err);
          alert('Failed to update anywhere configuration. Please try again.');
        },
      });
    } else {
      // No existing "anywhere" found, create new one
      console.log('No existing anywhere found, creating new one');
      this.apollo.mutate({
        mutation: CREATE_POSTAL_CODE,
        variables: {
          input: {
            code: this.anywhereCode.trim(),
            isAnywhere: true
          }
        },
        refetchQueries: [{ query: GET_POSTAL_CODES }]
      }).subscribe({
        next: () => {
          this.selectedOption = 'anywhere';
          this.isAnywhereConfigured = true;
          this.fetchPostalCodes();
        },
        error: (err) => {
          console.error('Failed to create anywhere configuration', err);
          alert('Failed to create anywhere configuration. Please try again.');
        },
      });
    }
  }

  saveCustom() {
    // Delete "anywhere" configuration if it exists to activate custom mode
    const anywhereConfig = this.postalCodes.find(pc => pc.isAnywhere);
    
    if (anywhereConfig) {
      // Delete "anywhere" configuration
      this.apollo.mutate({
        mutation: DELETE_POSTAL_CODE,
        variables: { id: anywhereConfig.id },
        refetchQueries: [{ query: GET_POSTAL_CODES }]
      }).subscribe({
        next: () => {
          this.isAnywhereConfigured = false;
          this.selectedOption = 'custom';
          // If custom postal codes exist, mark as configured
          if (this.customPostalCodes.length > 0) {
            this.isCustomConfigured = true;
          }
          this.fetchPostalCodes();
        },
        error: (err) => {
          console.error('Failed to delete anywhere configuration', err);
          // Still refresh to show custom postal codes
          this.fetchPostalCodes();
        },
      });
    } else {
      // No "anywhere" to delete, just refresh to show custom postal codes
      this.selectedOption = 'custom';
      // If custom postal codes exist, mark as configured
      if (this.customPostalCodes.length > 0) {
        this.isCustomConfigured = true;
      }
      this.fetchPostalCodes();
    }
  }

  onAddPostalCodeInput(event: any) {
    // Only allow numbers
    const value = event.target.value;
    const numbersOnly = value.replace(/[^0-9]/g, '');
    if (value !== numbersOnly) {
      this.newPostalCode = numbersOnly;
      event.target.value = numbersOnly;
    } else {
      this.newPostalCode = numbersOnly;
    }
    this.checkDuplicate();
  }

  onEditPostalCodeInput(event: any) {
    // Only allow numbers
    const value = event.target.value;
    const numbersOnly = value.replace(/[^0-9]/g, '');
    if (value !== numbersOnly) {
      this.editCode = numbersOnly;
      event.target.value = numbersOnly;
    } else {
      this.editCode = numbersOnly;
    }
  }

  checkDuplicate() {
    if (!this.newPostalCode || this.newPostalCode.trim() === '') {
      this.duplicateError = '';
      return;
    }
    
    const trimmedCode = this.newPostalCode.trim().toLowerCase();
    const isDuplicate = this.customPostalCodes.some(
      pc => pc.code.toLowerCase() === trimmedCode
    );
    
    if (isDuplicate) {
      this.duplicateError = 'This postal code already exists. Duplicate not allowed.';
    } else {
      this.duplicateError = '';
    }
  }

  onSearchFocus(event: any) {
    event.target.removeAttribute('readonly');
  }

  onAddFocus(event: any) {
    event.target.removeAttribute('readonly');
  }

  onSearchChange() {
    this.applySearchFilter();
  }

  applySearchFilter() {
    if (!this.searchPostalCode || this.searchPostalCode.trim() === '') {
      this.filteredPostalCodes = [...this.customPostalCodes];
    } else {
      const searchTerm = this.searchPostalCode.trim().toLowerCase();
      this.filteredPostalCodes = this.customPostalCodes.filter(
        pc => pc.code.toLowerCase().includes(searchTerm)
      );
    }
  }

  addPostalCode() {
    if (!this.newPostalCode || this.newPostalCode.trim() === '') {
      return;
    }

    // Check for duplicate before adding
    this.checkDuplicate();
    if (this.duplicateError) {
      return;
    }

    // If "anywhere" exists, delete it first when adding custom postal code
    const anywhereConfig = this.postalCodes.find(pc => pc.isAnywhere);
    
    const deleteAnywhereIfExists = () => {
      if (anywhereConfig) {
        return this.apollo.mutate({
          mutation: DELETE_POSTAL_CODE,
          variables: { id: anywhereConfig.id }
        }).toPromise();
      }
      return Promise.resolve();
    };

    deleteAnywhereIfExists().then(() => {
      // Now create the custom postal code
      this.apollo.mutate({
        mutation: CREATE_POSTAL_CODE,
        variables: {
          input: {
            code: this.newPostalCode.trim(),
            isAnywhere: false
          }
        },
        refetchQueries: [{ query: GET_POSTAL_CODES }]
      }).subscribe({
        next: () => {
          this.newPostalCode = '';
          this.duplicateError = '';
          // Don't change selectedOption - let user control the mode
          // If anywhere was deleted, update the flag
          this.isAnywhereConfigured = false;
          // Mark custom as configured after adding postal code
          this.isCustomConfigured = true;
          // Refresh the list to show the newly added postal code
          this.fetchPostalCodes();
        },
        error: (err) => {
          console.error('Failed to create postal code', err);
          if (err.graphQLErrors && err.graphQLErrors.length > 0) {
            alert('Error: ' + err.graphQLErrors[0].message);
          } else {
            alert('Failed to create postal code. Please try again.');
          }
        },
      });
    }).catch((err) => {
      console.error('Failed to delete anywhere configuration', err);
      // Still try to create the postal code
      this.apollo.mutate({
        mutation: CREATE_POSTAL_CODE,
        variables: {
          input: {
            code: this.newPostalCode.trim(),
            isAnywhere: false
          }
        },
        refetchQueries: [{ query: GET_POSTAL_CODES }]
      }).subscribe({
        next: () => {
          this.newPostalCode = '';
          this.duplicateError = '';
          // Don't change selectedOption - let user control the mode
          // Mark custom as configured after adding postal code
          this.isCustomConfigured = true;
          this.fetchPostalCodes();
        },
        error: (err) => {
          console.error('Failed to create postal code', err);
          alert('Failed to create postal code. Please try again.');
        },
      });
    });
  }

  editPostalCode(postalCode: { id: string; code: string }) {
    this.editingPostalCode = postalCode;
    this.editCode = postalCode.code;
  }

  cancelEdit() {
    this.editingPostalCode = null;
    this.editCode = '';
  }

  saveEdit() {
    if (!this.editingPostalCode || !this.editCode || this.editCode.trim() === '') {
      return;
    }

    this.apollo.mutate({
      mutation: UPDATE_POSTAL_CODE,
      variables: {
        input: {
          id: this.editingPostalCode.id,
          code: this.editCode.trim()
        }
      },
      refetchQueries: [{ query: GET_POSTAL_CODES }]
    }).subscribe({
      next: () => {
        this.cancelEdit();
        this.fetchPostalCodes();
      },
      error: (err) => console.error('Failed to update postal code', err),
    });
  }

  deletePostalCode(id: string) {
    if (!confirm('Are you sure you want to delete this postal code?')) {
      return;
    }

    this.apollo.mutate({
      mutation: DELETE_POSTAL_CODE,
      variables: { id },
      refetchQueries: [{ query: GET_POSTAL_CODES }]
    }).subscribe({
      next: () => {
        this.selectedPostalCodeForCrud = '';
        this.fetchPostalCodes();
      },
      error: (err) => console.error('Failed to delete postal code', err),
    });
  }

  // CRUD operations for dropdown selection
  onPostalCodeSelected() {
    // Selection is handled, actions available via buttons
  }

  getSelectedPostalCodeName(): string {
    if (!this.selectedPostalCodeForCrud) {
      return '';
    }
    const selected = this.customPostalCodes.find(pc => pc.id === this.selectedPostalCodeForCrud);
    return selected ? selected.code : '';
  }

  editSelectedPostalCode() {
    if (!this.selectedPostalCodeForCrud) {
      return;
    }
    const selected = this.customPostalCodes.find(pc => pc.id === this.selectedPostalCodeForCrud);
    if (selected) {
      this.editPostalCode(selected);
    }
  }

  deleteSelectedPostalCode() {
    if (!this.selectedPostalCodeForCrud) {
      return;
    }
    this.deletePostalCode(this.selectedPostalCodeForCrud);
  }

  clearSelection() {
    this.selectedPostalCodeForCrud = '';
  }
}


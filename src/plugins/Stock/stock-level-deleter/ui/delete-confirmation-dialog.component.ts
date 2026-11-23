import { Component } from '@angular/core';
import { Dialog, SharedModule } from '@vendure/admin-ui/core';

export interface DeleteConfirmationDialogData {
  locationName: string;
}

@Component({
  selector: 'delete-confirmation-dialog',
  standalone: true,
  imports: [SharedModule],
  template: `
    <ng-template vdrDialogTitle>Confirm Deletion</ng-template>
    <div class="confirmation-dialog">
      <p class="message">
        Are you sure you want to remove the stock location 
        <strong>"{{ locationName }}"</strong>?
      </p>
      <p class="warning">This action cannot be undone.</p>
    </div>
    <ng-template vdrDialogButtons>
      <button type="button" class="btn btn-secondary" (click)="cancel()">
        Cancel
      </button>
      <button type="button" class="btn btn-danger" (click)="confirm()">
        Delete
      </button>
    </ng-template>
  `,
  styles: [`
    .confirmation-dialog {
      padding: 1rem 0;
    }

    .message {
      margin: 0 0 0.5rem 0;
      color: var(--color-text-100);
      font-size: 0.9375rem;
      line-height: 1.5;
    }

    .message strong {
      color: var(--color-text-200);
      font-weight: 600;
    }

    .warning {
      margin: 0;
      color: var(--color-warning-500);
      font-size: 0.875rem;
      font-style: italic;
    }
  `]
})
export class DeleteConfirmationDialogComponent implements Dialog<boolean> {
  resolveWith: (result?: boolean) => void;
  locationName: string;

  confirm() {
    this.resolveWith(true);
  }

  cancel() {
    this.resolveWith(false);
  }
}


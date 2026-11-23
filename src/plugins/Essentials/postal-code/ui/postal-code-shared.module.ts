import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { SharedModule } from '@vendure/admin-ui/core';
import { PostalCodeDropdownDirective } from './postal-code-dropdown.directive';

@NgModule({
    imports: [CommonModule, FormsModule, ReactiveFormsModule, SharedModule],
    declarations: [PostalCodeDropdownDirective],
    exports: [PostalCodeDropdownDirective],
})
export class PostalCodeSharedModule {}



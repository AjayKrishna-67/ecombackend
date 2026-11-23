import { NgModule, APP_INITIALIZER } from '@angular/core';
import { PostalCodeSharedModule } from './postal-code-shared.module';
import { PostalCodeReplacerService } from './postal-code-replacer.service';

/**
 * This module makes the PostalCodeDropdownDirective available globally
 * so it can intercept postal code input fields in address forms
 */
@NgModule({
    imports: [PostalCodeSharedModule],
    exports: [PostalCodeSharedModule],
    providers: [
        PostalCodeReplacerService,
        {
            provide: APP_INITIALIZER,
            useFactory: (service: PostalCodeReplacerService) => () => {
                // Service constructor will handle initialization
                return Promise.resolve();
            },
            deps: [PostalCodeReplacerService],
            multi: true
        }
    ]
})
export class PostalCodeUiExtensionModule {}


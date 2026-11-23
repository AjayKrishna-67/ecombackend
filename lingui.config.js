import { defineConfig } from '@lingui/cli';

export default defineConfig({
    sourceLocale: 'en',
    // Add any locales you wish to support
    locales: ['en', 'de'],
    catalogs: [
        // For each plugin you want to localize, add a catalog entry
        {
            // This is the output location of the generated .po files
            path: '<rootDir>/src/plugins/reviews/dashboard/i18n/{locale}',
            // This is the pattern that tells Lingui which files to scan
            // to extract translation strings
            include: ['<rootDir>/src/plugins/reviews/dashboard/**'],
        },
    ],
});
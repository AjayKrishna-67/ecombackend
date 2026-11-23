import { defineConfig } from 'vitest/config';

// Fast unit-test config: runs plain *.spec.ts units (pure functions, services with
// mocked deps) WITHOUT the dashboard build plugin / GraphQL introspection that
// vitest.config.mts pulls in. Use: bunx vitest run --config vitest.unit.config.mts
//
// e2e specs are named *.e2e-spec.ts, which does NOT match the *.spec.ts glob
// (the separator before "spec" is a hyphen, not a dot). The explicit exclude
// below states that intent rather than leaving it to a filename coincidence.
export default defineConfig({
    test: {
        include: ['src/**/*.spec.ts'],
        exclude: ['**/node_modules/**', '**/dist/**', '**/*.e2e-spec.ts'],
        environment: 'node',

        // 'verbose' prints every test name and duration; the rest write files.
        // Console output and machine-readable artifacts are different audiences --
        // a CI job cannot parse a terminal table, and a human cannot read XML.
        reporters: ['verbose', 'json', 'junit', 'html'],
        outputFile: {
            json: './reports/unit/results.json',
            junit: './reports/unit/junit.xml',
            html: './reports/unit/index.html',
        },

        coverage: {
            provider: 'v8',
            // 'text' for the terminal, 'html' to browse line-by-line, 'lcov' for
            // external tools (SonarQube, Codecov), 'json-summary' for a one-line
            // percentage a CI badge or script can read without parsing lcov.
            reporter: ['text', 'html', 'lcov', 'json-summary'],
            reportsDirectory: './reports/coverage',

            // Only our own source. Without this, v8 reports on every file the
            // tests happen to touch -- including migrations and generated GraphQL
            // types -- which drags the headline number down and hides whether the
            // code we actually wrote is tested.
            include: ['src/plugins/**/*.ts'],
            exclude: [
                '**/*.spec.ts',
                '**/*.e2e-spec.ts',
                '**/__tests__/**',
                '**/dashboard/**',
                '**/ui/**',
                '**/*.entity.ts',
                '**/api-extensions.ts',
                '**/*.plugin.ts',
                '**/generated-*.ts',
            ],

            // Deliberately not a global threshold. A repo-wide floor either sits
            // so low it never fires, or blocks work on untested legacy code that
            // has nothing to do with the change in hand. A per-glob ratchet puts
            // the floor only where coverage has actually been earned.
            thresholds: {
                'src/plugins/Essentials/scheduled-availability/functions/**': {
                    statements: 90,
                    branches: 80,
                    functions: 90,
                    lines: 90,
                },
            },
        },
    },
});

import { defineConfig } from 'vitest/config';

// End-to-end config: boots a real Vendure server on an in-memory sql.js database
// and drives it through the Admin GraphQL API.
//
// Separate from vitest.unit.config.mts because the two have opposite economics.
// Units run in milliseconds and should be run on every save; each e2e suite pays
// several seconds to bootstrap a server, so they are opt-in.
//
// Use: bun run test:e2e
export default defineConfig({
    test: {
        include: ['src/**/*.e2e-spec.ts'],
        environment: 'node',

        // A Vendure bootstrap is far slower than the 5s default, and the sql.js
        // population step in beforeAll is slower still.
        testTimeout: 60_000,
        hookTimeout: 180_000,

        // One process, one suite at a time. Every suite created from `testConfig`
        // inherits the same API port, so parallel files race for it and the
        // second to bind dies with EADDRINUSE. Serialising is the cheap fix;
        // assigning a unique port per suite is the alternative once suites
        // multiply enough for the wall-clock cost to matter.
        pool: 'forks',
        maxWorkers: 1,
        fileParallelism: false,

        reporters: ['verbose', 'json', 'junit'],
        outputFile: {
            json: './reports/e2e/results.json',
            junit: './reports/e2e/junit.xml',
        },
    },
});

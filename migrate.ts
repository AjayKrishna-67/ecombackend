import { generateMigration, revertLastMigration, runMigrations } from '@vendure/core';
import { Command } from 'commander';
import { config } from './src/vendure-config';

const program = new Command();

program
    .command('generate <name>')
    .description('Generate a new migration file from current schema diff')
    .action(async name => {
        await generateMigration(config, { name, outputDir: './src/migrations' });
    });

program
    .command('run')
    .description('Run all pending migrations')
    .action(async () => {
        await runMigrations(config);
    });

program
    .command('revert')
    .description('Revert the last applied migration')
    .action(async () => {
        await revertLastMigration(config);
    });

program.parse(process.argv);

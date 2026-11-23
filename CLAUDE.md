# Vendure E-Commerce Platform - v3.6.3

This is a customized Vendure e-commerce platform with extended admin UI features and custom plugins.

## Project Overview

**Framework**: Vendure 3.6.3 (Node.js e-commerce framework built on NestJS)
**Admin UI**: Angular 19.2 (`@vendure/admin-ui` 3.6.3)
**Database**: MySQL2 3.14
**Testing**: Vitest 4 with coverage support
**Working Branch**: KochiPWA
**PR Target**: master

Vendure 3.6.3 means the 3.3+ `ScheduledTask` API is available — prefer it over `setInterval` for recurring work.

## Quick Commands

This project uses **bun** as the package manager/runner. Always use `bun run <script>`, never `npm run`.

```bash
# Development
bun run dev:server       # Server only — USE THIS for dev/testing
bun run dev:worker       # Worker only
bun run dev              # Both — most work does not need the worker; see below

# Building
bun run build            # Full build (TypeScript + admin UI)
bun run build:admin      # Rebuild admin UI only

# Testing
bun test                 # Run all tests
bun run test:watch       # Watch mode
bun run test:coverage    # With coverage

# Code Generation
bun run codegen          # Generate GraphQL types
```

### Server vs worker

The server (`src/index.ts`) answers requests: GraphQL queries and mutations, permission
checks, reads and writes — all inside the request. The worker (`src/index-worker.ts`)
takes jobs off the queue and runs them. **The server only ever enqueues; the worker is
what executes.** Without it, jobs sit in Redis indefinitely — nothing is lost, but
nothing happens either. Both must run in production; the worker is not an optional extra.

| Needs the worker | Server alone is enough |
|---|---|
| `DefaultSearchPlugin` reindex after a product edit | Anything answered inside a request |
| `ScheduledTask` (expiry sweeps and similar) | Goods Transfer end to end — it queues no jobs |
| Email / SMS / OTP delivery | Direct DB reads such as product pickers |
| Bulk import and export | |

Caution while developing: this environment can still reach live customers, because
outbound sends are not yet suppressed outside production. Closing that gap — an
`IS_PROD` guard at the sender — is what makes the worker safe to leave running; until
then, start it deliberately rather than by habit.

## Architecture

### Core Directories

- [admin-ui/](admin-ui/) - Angular-based admin interface
  - [src/extensions/](admin-ui/src/extensions/) - Custom UI components
  - [src/extension.routes.ts](admin-ui/src/extension.routes.ts) - Route configuration

- [src/plugins/](src/plugins/) - Custom Vendure plugins
  - **Authenticated/** - OTP and authentication mechanisms
  - **Payment/** - Payment gateway integrations (Razorpay)
  - **Shipping/** - Shipping methods and calculations
  - **Essentials/** - Core business logic extensions

### Key Files

- [src/index.ts](src/index.ts) - Main server entry point
- [src/index-worker.ts](src/index-worker.ts) - Worker process
- [vitest.config.mts](vitest.config.mts) - Test configuration
- [tsconfig.json](tsconfig.json) - TypeScript configuration

## Development Guidelines

See [@.claude/rules/vendure-backend.md](.claude/rules/vendure-backend.md) for comprehensive coding standards.

## Key Plugins

### Razorpay Payment Integration
**Path**: [src/plugins/Payment/Razorpay/](src/plugins/Payment/Razorpay/)
Handles payment processing, webhooks, and order management.

### Phone OTP Authentication
**Path**: [src/plugins/Authenticated/otpmechanism/](src/plugins/Authenticated/otpmechanism/)
SMS-based authentication strategy with OTP verification.

### Shipping Method Filter
**Path**: [src/plugins/Shipping/shipping-method-filter/](src/plugins/Shipping/shipping-method-filter/)
Weight-based shipping calculations with channel support.

### Postal Code Management
**Path**: [admin-ui/src/extensions/postal-code/](admin-ui/src/extensions/postal-code/)
Admin UI for managing postal codes and delivery zones.

## Testing Strategy

- Unit tests: Test individual services and resolvers
- Integration tests: Test plugin functionality end-to-end
- Use `@vendure/testing` utilities
- Vitest configuration in [vitest.config.mts](vitest.config.mts)

## Environment Variables

See [.env.example](.env.example) for required configuration.

## Reuse Before Creating

1. Reference must come from **outside the process being worked on**. When building/rebuilding a process (e.g. Goods Transfer), look at other parts of the project for the pattern — order creation, other Stock plugins, existing Vendure core services.
2. Never cite a file inside the process being built as "already solved, reuse it". That folder is the work itself, not a reference. Citing it produces a duplicate.
3. Within one process, the same logic must exist in exactly one place. No duplicate entity fields, services, resolvers, or queries doing the same job.
4. If an existing external API / service / entity covers the need, reuse or extend it. Do not create a parallel one.
5. Create something new only when nothing existing can serve the need. State why.
6. No speculative or "just in case" APIs, fields, or endpoints. Only what the task requires.
7. **A new API or query needs the user's explicit acceptance before it is written.** Name it, say why nothing existing covers it, get a yes. Reuse never needs asking.
8. Aim for the fewest APIs possible — but every one that survives must earn its place. Prefer adding a field to an existing input over adding a mutation.

## Check Before Implementing

Every time the user states a requirement, verify it against the actual code and data **before** writing anything.

1. Confirm the thing they described exists and behaves as they believe. Read the file; do not assume.
2. If what you find contradicts the requirement, or the requirement would break something else, **say so and ask before implementing** — not after.
3. If the requirement is already satisfied by existing code, say that instead of building it again.
4. Raise the doubt while it is still cheap: before the code, not in the review.

This is not an invitation to reopen settled decisions. Once an approach has been chosen, do not ask which option is preferred — but do ask when the chosen thing appears wrong, impossible, or ambiguous in a way that changes the result.

## Verify Before Executing

1. Read the actual reference file(s) before implementing — never work from memory or assumption about what a file contains.
2. Confirm the referenced symbols, imports, and paths exist as used.
3. Deliver code that runs clean. "Error at execution" is not acceptable as an outcome — check it first.
4. **An inconclusive check is a failed check.** Empty output, `undefined`, a blocked command, a skipped test — none of these mean "fine". Either find a check that answers the question, or say plainly that it could not be verified. Never let a settings/config/permission item pass on a check that returned nothing.
5. When a configuration value matters, read it back from the running system, not from what was intended. Example: Redis eviction policy — `CONFIG GET maxmemory-policy` returns `[]` on managed Redis, but `INFO memory` reports `maxmemory_policy` correctly.

## Resources

- Vendure Docs: https://docs.vendure.io/
- Admin UI Guide: https://docs.vendure.io/guides/extending-the-admin-ui/
- Plugin Development: https://docs.vendure.io/guides/developer-guide/plugins/

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

import { DefaultLogger, LogLevel, VendureLogger } from '@vendure/core';

/**
 * Vendure core's CustomFieldsValidationSubscriber validates a saved entity's
 * customFields keys against the registered field *names*. For a relation custom
 * field, the GraphQL input uses the mandated `<name>Id` / `<name>Ids` alias, and
 * that alias briefly lands on the entity — so the subscriber logs a false-positive
 * warning like "Custom field addonGroupsIds not found for entity ProductVariant"
 * on every save that touches a relation custom field. The relation still persists.
 *
 * This logger wraps DefaultLogger and drops ONLY that specific false positive
 * (message matching a `<field>Id`/`<field>Ids` alias). Any other "not found"
 * warning — a genuinely mistyped custom field — still passes through, because those
 * do not end in the relation-alias suffix.
 */
const RELATION_ALIAS_FALSE_POSITIVE = /^Custom field \S+Ids? not found for entity /;

export class RelationAliasFilterLogger implements VendureLogger {
    private readonly delegate: DefaultLogger;

    constructor(options?: { level?: LogLevel; timestamp?: boolean }) {
        this.delegate = new DefaultLogger(options);
    }

    setDefaultContext(defaultContext: string): void {
        this.delegate.setDefaultContext?.(defaultContext);
    }

    error(message: string, context?: string, trace?: string): void {
        this.delegate.error(message, context, trace);
    }

    warn(message: string, context?: string): void {
        if (RELATION_ALIAS_FALSE_POSITIVE.test(message)) {
            return;
        }
        this.delegate.warn(message, context);
    }

    info(message: string, context?: string): void {
        this.delegate.info(message, context);
    }

    verbose(message: string, context?: string): void {
        this.delegate.verbose(message, context);
    }

    debug(message: string, context?: string): void {
        this.delegate.debug(message, context);
    }
}

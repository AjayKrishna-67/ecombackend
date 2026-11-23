/**
 * Sorted longest-first so a longer verb always wins over a shorter one that
 * happens to prefix it. Without this, `settlePayment` matches `set` and the
 * entity type comes out as `tlePayment`.
 */
const OPERATION_VERBS = [
    'create',
    'update',
    'delete',
    'add',
    'remove',
    'assign',
    'unassign',
    'set',
    'settle',
    'save',
    'move',
    'cancel',
    'refund',
    'fulfill',
    'transition',
    'modify',
    'apply',
    'import',
    'export',
    'sync',
    'reindex',
    'duplicate',
].sort((a, b) => b.length - a.length);

/**
 * Words that join two entity names in a mutation, e.g. `addFulfillmentToOrder`.
 * The subject is whatever precedes them. Each must be followed by an uppercase
 * letter to count, so `createToken` is not mangled into `Ken` by the `To` rule.
 */
const CONNECTOR_PATTERN = /(?:To|For|From|With|On|In)(?=[A-Z])/;

/**
 * Mutations whose name does not describe the entity they act on.
 *
 * `setVariantTags` parses to an entity type of `VariantTag`, which is not a
 * thing — the mutation edits the tags OF a product variant, and its id argument
 * is `variantId`. Filing it under the invented type is not just a bad label: the
 * `(entityType, entityId)` pair is the indexed lookup behind "everything that
 * happened to variant 949", so the tagging never appears in that variant's own
 * history.
 *
 * Kept as an explicit list rather than another naming heuristic. These are
 * project-specific plugin mutations that no general rule derived from the verb
 * grammar could get right, and a wrong guess here silently hides rows.
 */
const OPERATION_TARGET_OVERRIDES: Record<string, { entityType: string; idKey: string }> = {
    setVariantTags: { entityType: 'ProductVariant', idKey: 'variantId' },
    setProductTags: { entityType: 'Product', idKey: 'productId' },
};

export interface ActivityTarget {
    entityType: string | null;
    entityId: string | null;
    targetCount: number;
}

function toSingular(value: string): string {
    if (value.endsWith('ies')) {
        return `${value.slice(0, -3)}y`;
    }
    if (value.endsWith('ses')) {
        return value.slice(0, -2);
    }
    if (value.endsWith('s') && !value.endsWith('ss')) {
        return value.slice(0, -1);
    }
    return value;
}

/**
 * A verb only counts when the character after it is uppercase, i.e. the verb
 * ends on a camelCase boundary. `settlePayment` would otherwise match `set` and
 * leave the remainder `tlePayment`, which is how a real mutation ended up
 * labelled with a nonsense entity type in the log.
 */
function deriveEntityType(operationName: string): string | null {
    const verb = OPERATION_VERBS.find(candidate => {
        if (!operationName.toLowerCase().startsWith(candidate)) {
            return false;
        }
        const next = operationName.charAt(candidate.length);
        return next !== '' && next === next.toUpperCase() && next !== next.toLowerCase();
    });
    if (!verb) {
        return null;
    }
    // Keep only the subject: `addFulfillmentToOrder` is an action on a
    // Fulfillment, not on a thing called "FulfillmentToOrder". Without this the
    // same entity yields a different entityType per mutation, which breaks the
    // "everything that happened to X" lookup the column exists for.
    const subject = operationName.slice(verb.length).split(CONNECTOR_PATTERN)[0];
    if (subject.length === 0) {
        return null;
    }
    return toSingular(subject);
}

function readId(candidate: unknown): string | null {
    if (typeof candidate === 'string' || typeof candidate === 'number') {
        return String(candidate);
    }
    if (candidate && typeof candidate === 'object' && 'id' in candidate) {
        const inner = (candidate as { id: unknown }).id;
        return typeof inner === 'string' || typeof inner === 'number' ? String(inner) : null;
    }
    return null;
}

function collectFromInput(input: unknown): string[] {
    if (Array.isArray(input)) {
        return input.map(readId).filter((id): id is string => id !== null);
    }
    const single = readId(input);
    return single ? [single] : [];
}

function collectIds(args: Record<string, unknown>): string[] {
    if (Array.isArray(args.ids)) {
        return args.ids.map(readId).filter((id): id is string => id !== null);
    }
    const direct = readId(args.id);
    if (direct) {
        return [direct];
    }
    const fromInput = collectFromInput(args.input);
    if (fromInput.length > 0) {
        return fromInput;
    }
    const suffixedKey = Object.keys(args).find(key => key.endsWith('Id') && readId(args[key]) !== null);
    return suffixedKey ? [readId(args[suffixedKey]) as string] : [];
}

/**
 * Derives the best-effort audit target from a GraphQL mutation name and its
 * arguments, so the log can answer "show me everything that happened to
 * product 412" rather than only "list what this admin did".
 *
 * Best-effort is deliberate. `operationName` on the row is always the ground
 * truth; this only populates the indexed lookup columns. A mutation whose shape
 * this does not recognise still produces a complete audit row with null target
 * columns, never a dropped row.
 *
 * `targetCount` records blast radius: one `updateProductVariants` call carrying
 * 200 ids is a single row with `targetCount: 200`, which is what makes bulk
 * mistakes visible in the list without exploding the table.
 */
export function extractTarget(operationName: string, args: unknown): ActivityTarget {
    const override = OPERATION_TARGET_OVERRIDES[operationName];
    const entityType = override?.entityType ?? deriveEntityType(operationName);
    if (!args || typeof args !== 'object') {
        return { entityType, entityId: null, targetCount: 1 };
    }
    if (override) {
        const overrideId = readId((args as Record<string, unknown>)[override.idKey]);
        return { entityType, entityId: overrideId, targetCount: 1 };
    }
    const ids = collectIds(args as Record<string, unknown>);
    return {
        entityType,
        entityId: ids.length === 1 ? ids[0] : null,
        targetCount: ids.length > 0 ? ids.length : 1,
    };
}

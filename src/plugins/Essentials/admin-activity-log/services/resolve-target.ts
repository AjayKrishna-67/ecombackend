type Json = Record<string, unknown>;

/**
 * Entity types that have a Dashboard detail page addressed by a bare id.
 *
 * This is an ALLOWLIST, never a derivation, because `entityType` is the
 * best-effort output of a naming heuristic and the table already contains proof
 * that it produces nonsense: rows filed under `tlePayment` (a pre-fix
 * `settlePayment`), `FulfillmentToOrder` and `FulfillmentToState` are all still
 * there and always will be. Deriving a URL from those would turn every one of
 * them into a link that 404s. Heuristic output may be displayed; it must not be
 * acted on, and making it clickable is acting on it.
 *
 * Types deliberately absent: `Fulfillment` and `Payment` live inside an order
 * page and their payloads carry no order id, so linking them would need a
 * lookup that buys nothing today; `SettingsStoreValue` has no page at all.
 *
 * Paths are verified against the routes the installed `@vendure/dashboard`
 * actually registers. A variant links straight to `/product-variants/$id` — it
 * needs no parent product id.
 */
const ENTITY_ROUTES: Record<string, string> = {
    Administrator: '/administrators',
    ApiKey: '/api-keys',
    Asset: '/assets',
    Channel: '/channels',
    Collection: '/collections',
    Country: '/countries',
    Customer: '/customers',
    CustomerGroup: '/customer-groups',
    Facet: '/facets',
    Order: '/orders',
    PaymentMethod: '/payment-methods',
    Product: '/products',
    ProductOptionGroup: '/option-groups',
    ProductVariant: '/product-variants',
    Promotion: '/promotions',
    Role: '/roles',
    Seller: '/sellers',
    ShippingMethod: '/shipping-methods',
    StockLocation: '/stock-locations',
    TaxCategory: '/tax-categories',
    TaxRate: '/tax-rates',
    Zone: '/zones',
};

export interface ResolvedTarget {
    /** Human name of the entity this row acted on, or null when unknowable. */
    label: string | null;
    /** Dashboard path, or null when this row must not be clickable. */
    link: string | null;
}

/**
 * Works out what to call the entity a row acted on, and where clicking it should
 * go.
 *
 * The name is read from the row's OWN payload rather than from the entity as it
 * stands today, and that is deliberate. An audit row records what happened at a
 * moment; if a product is renamed next month, the row for last month's edit must
 * still say what it was called when the operator changed it. Resolving names
 * live would quietly rewrite history — the same reason `adminName` is snapshotted
 * onto the row instead of joined from Administrator.
 *
 * It also costs nothing: `updateProduct` and `updateProductVariant` payloads
 * already carry `translations[].name`, so the two entity types that dominate this
 * log are named with zero extra queries.
 *
 * The link is the opposite case and must be live — a link exists to reach the
 * thing as it is now — so it is built from the allowlist and the stored id, with
 * no attempt to prove the entity still exists.
 */
export function resolveTarget(input: {
    entityType: string | null;
    entityId: string | null;
    payload: Json | null;
    languageCode?: string;
}): ResolvedTarget {
    return {
        label: readPayloadName(input.payload, input.languageCode),
        link: buildLink(input.entityType, input.entityId),
    };
}

function buildLink(entityType: string | null, entityId: string | null): string | null {
    if (entityType === null || entityId === null) {
        return null;
    }
    const base = ENTITY_ROUTES[entityType];
    return base === undefined ? null : `${base}/${entityId}`;
}

/**
 * Reads a display name out of a mutation payload.
 *
 * Translated entities are tried first and are matched on the viewer's language
 * before falling back to any translation that carries a non-empty name. That
 * fallback is load-bearing on this catalogue: a variant payload routinely holds
 * three translations where only the English one has a name and the Tamil and
 * Malayalam rows are empty strings, so "the first translation" would resolve to
 * `''` and read as a missing name.
 */
function readPayloadName(payload: Json | null, languageCode = 'en'): string | null {
    const input = unwrapInput(payload);
    if (input === null) {
        return null;
    }
    const fromTranslations = readTranslatedName(input.translations, languageCode);
    if (fromTranslations !== null) {
        return fromTranslations;
    }
    const direct = firstNonEmptyString([input.name, input.code, input.identifier]);
    if (direct !== null) {
        return direct;
    }
    const person = [input.firstName, input.lastName]
        .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
        .join(' ');
    return person === '' ? null : person;
}

function readTranslatedName(translations: unknown, languageCode: string): string | null {
    if (!Array.isArray(translations)) {
        return null;
    }
    const preferred = translations.find(
        item => isObject(item) && item.languageCode === languageCode && isNonEmptyString(item.name),
    );
    if (isObject(preferred) && isNonEmptyString(preferred.name)) {
        return preferred.name.trim();
    }
    for (const item of translations) {
        if (isObject(item) && isNonEmptyString(item.name)) {
            return item.name.trim();
        }
    }
    return null;
}

function firstNonEmptyString(candidates: unknown[]): string | null {
    for (const candidate of candidates) {
        if (isNonEmptyString(candidate)) {
            return candidate.trim();
        }
    }
    return null;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}

function unwrapInput(payload: Json | null): Json | null {
    if (!isObject(payload)) {
        return null;
    }
    const input = payload.input;
    if (Array.isArray(input)) {
        return isObject(input[0]) ? input[0] : payload;
    }
    return isObject(input) ? input : payload;
}

function isObject(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strips any Vendure asset `preset` query param from an image URL. The admin
 * asset pipeline force-appends `?preset=thumb` (a 150x150 crop) to every URL so
 * the dashboard grid loads fast, and that thumb URL is what gets saved as the
 * header image. WhatsApp must receive the full-resolution image (the original
 * 1080x607 upload), so we drop the preset — no preset serves the full-size
 * preview at the source dimensions. Other query params are preserved.
 */
export function toFullSizeImageUrl(url: string): string {
    let out = url.replace(/([?&])preset=[^&#]*/gi, '$1'); // remove preset, keep leading ? or &
    out = out.replace(/[?&]$/, '');   // drop a now-trailing ? or &
    out = out.replace(/\?&/, '?');    // "?&foo" -> "?foo"
    out = out.replace(/&&+/g, '&');   // collapse doubled &
    return out;
}

/**
 * Assembles the MSG91 `components` object for a WhatsApp template send: optional image header
 * (header_1), the body variables (body_1..n), and an optional URL button (button_1). Header/
 * button are omitted when not provided, so plain body-only templates are unaffected.
 */
export function buildWhatsappComponents(args: {
    vars: Record<string, { type: 'text'; value: string }>;
    headerImageUrl?: string;
    buttonUrlValue?: string;
}): Record<string, any> {
    const components: Record<string, any> = {};
    if (args.headerImageUrl) {
        components.header_1 = { type: 'image', value: toFullSizeImageUrl(args.headerImageUrl) };
    }
    Object.assign(components, args.vars);
    if (args.buttonUrlValue) {
        components.button_1 = { subtype: 'url', type: 'text', value: args.buttonUrlValue };
    }
    return components;
}

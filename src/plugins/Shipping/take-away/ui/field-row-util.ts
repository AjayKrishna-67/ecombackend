/**
 * Finds the outermost wrapper of a custom-field row that can be hidden
 * without touching any other field: climbs from `host` while the parent
 * contains no interactive controls outside the current subtree.
 */
export function findFieldRowWrapper(host: HTMLElement): HTMLElement {
    const containsForeignControls = (parent: HTMLElement, self: HTMLElement) =>
        Array.from(
            parent.querySelectorAll('input, textarea, select, iframe, store-location-map-input'),
        ).some(el => !self.contains(el));
    let wrapper: HTMLElement = host;
    while (
        wrapper.parentElement &&
        wrapper.parentElement !== document.body &&
        wrapper.parentElement.tagName !== 'FORM' &&
        !containsForeignControls(wrapper.parentElement, wrapper)
    ) {
        wrapper = wrapper.parentElement;
    }
    return wrapper;
}

/**
 * Idempotent customElement decorator for Lit elements.
 * Prevents "the name has already been used with this registry" errors
 * when Home Assistant reloads or re-imports panel bundles.
 */
export const customElement = (tagName: string) => (target: any) => {
  if (typeof customElements !== "undefined" && !customElements.get(tagName)) {
    customElements.define(tagName, target);
  }
};

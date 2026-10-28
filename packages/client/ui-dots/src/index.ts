/**
 * Dots page, node half. The browser half registers the `main` page and its
 * Sidebar entry through `exports["./client"]`, discovered from this package's
 * `dsh.client` declaration. The durable dots, their Remote namespace, and the
 * model-facing tools live in `@deepseek-ai/dsh-dots` and
 * `@deepseek-ai/dsh-tool-dots`.
 */

/** Host plugin body — this surface plugin has no host-side behavior. */
export function apply(): void {}

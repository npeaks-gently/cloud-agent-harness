/**
 * SDK loader — isolates the dynamic import of the GSD SDK.
 *
 * Extracted into its own module so that tests can mock `./sdk-loader.js`
 * with vi.mock() instead of trying to intercept a dynamic import path.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GSDClass = new (options: Record<string, unknown>) => any;

/**
 * Dynamically loads the GSD SDK module.
 *
 * @returns Object containing the GSD class constructor
 */
export async function loadSdk(): Promise<{ GSD: GSDClass }> {
  const mod = await import('../../../sdk/src/index.js');
  return { GSD: mod.GSD };
}

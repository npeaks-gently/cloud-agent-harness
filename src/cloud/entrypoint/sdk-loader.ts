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
 * The import path is computed from CAH_SDK_PATH (set by the entrypoint for
 * Daytona, default `/harness/sdk/dist/index.js`) so esbuild does not inline
 * the SDK into the entrypoint bundle — the SDK must stay as a standalone
 * module on disk so its `import.meta.url`-relative lookups (prompts/,
 * gsd-tools.cjs) resolve to the deployed harness tree.
 *
 * @returns Object containing the GSD class constructor
 */
export async function loadSdk(): Promise<{ GSD: GSDClass }> {
  const sdkPath = process.env.CAH_SDK_PATH ?? '/harness/sdk/dist/index.js';
  const mod = await import(sdkPath);
  return { GSD: mod.GSD };
}

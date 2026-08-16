/**
 * `server:gateway/deno` — the Deno runtime gateway adapter (`Deno.serve` +
 * `Deno.upgradeWebSocket`). The Deno surface is injectable via `denoImpl` for tests and
 * embedders; the engine lives in core.
 */
export * from './definition'

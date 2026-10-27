import { ozacoSpecifiers } from './internal/specifiers'

/**
 * `@ozaco/devkit/bun` — the Bun PRELOAD that makes the family aliases resolve at runtime:
 * `preload = ["@ozaco/devkit/bun"]` in `bunfig.toml` and a test, a script or a dev server may
 * import `std:effect` / `db:core` / `server:impl/edge/bun` exactly as the packages' own source
 * does (the vite plugin does the same for a bundle). Importing this entry registers the plugin —
 * that is its whole purpose; `ozacoSpecifiers` is the plugin itself for a manual `Bun.plugin`.
 */
Bun.plugin(ozacoSpecifiers)

export { ozacoSpecifiers } from './internal/specifiers'

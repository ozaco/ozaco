/**
 * `server:wizard` — the Convex-like resource layer on `@ozaco/db`. Hook-style fn builders
 * (`query`/`mutation`/`action`), a `crud(table)` generator, `resource()` compiling fns into plain
 * core services, the `wizard()` api tree with typed in-process `run()`, `installWizard()` mounting
 * REST + `_realtime` WebSocket watch routes and a `_realtime/sse` SSE flavor (frames from
 * `server:core/frames`), and a change-bus bridge over the broker for multi-node reactivity on
 * write-through adapters.
 */
export * from './const'
export * from './definition'
export * from './errors'
export type * from './types'
export * from './utils/bus'
export * from './utils/crud'
export * from './utils/fn'
export * from './utils/realtime'
export * from './utils/resource'

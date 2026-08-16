/**
 * `server:policy/cache` — the outermost onion layer: serves repeated dispatches with the same key
 * from a scope-bound TTL'd map. Only `value` replies are cached — never streams or failures — and
 * entries vary per principal by default.
 */
export * from './definition'
export type * from './types'

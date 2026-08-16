/**
 * `server:policy/timeout` — the innermost onion layer: races the dispatch against a deadline and
 * raises `CoreErrors.TimeoutPending` (halting the abandoned work) when it loses, so every outer
 * layer can observe the timeout as a failure instead of a scope halt.
 */
export * from './definition'
export type * from './types'

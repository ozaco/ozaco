/**
 * `server:policy/circuit-breaker` — a per-action breaker: consecutive infrastructure failures (and
 * 5xx failure replies) open the circuit, open circuits reject instantly, and timed half-open
 * probes close it again on success.
 */
export * from './definition'
export type * from './types'
